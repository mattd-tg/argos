import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { imageManifest } from "./images.mjs";
import {
  compose,
  deploymentOutputs,
  entry,
  envText,
  gcloud,
  gcloudJson,
  jsonFile,
  OPERATOR_EMAIL,
  privateWrite,
  quote,
  ROOT,
  run,
  ssh,
  STATE,
  tenantNodes,
  verifyStorageBoundary,
  ZONE,
} from "./lib.mjs";
import { bootstrap, provisionIdentity } from "./operator.mjs";
import {
  assertPrivateFile,
  readProtectedJson,
  readRuntimeVersion,
  readTlsCandidate,
  stageRuntime,
} from "./secrets.mjs";

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[1-9][0-9]*$/;
const RELEASE = /^\/srv\/argos-poc\/releases\/[0-9]+-[a-f0-9]+$/;
const PIN_KEYS = [
  "RUNTIME_SECRET_VERSION",
  "CONNECTOR_SECRET_VERSION",
  "TLS_SECRET_VERSION",
];
const RELEASE_FILES = [
  "compose.yaml",
  "compose.connector.yaml",
  "gateway.yaml",
  "nginx/api.conf",
  "nginx/app.conf",
];
const LOAD_SECRETS = "/usr/local/lib/argos-poc/load-secrets.py";
const RELEASES_BUCKET = "twingate-playground-argos-poc-releases";
const USAGE =
  "Usage: deploy.mjs install|update --image sha256:<image-id> --runtime-version <N> [--archive <protected-tar>] [--tls-version <N> (update only)]; deploy.mjs ci --image sha256:<image-id> --archive <protected-tar>";

const save = (name, value) =>
  privateWrite(join(STATE, name), JSON.stringify(value, null, 2) + "\n");

async function remote(script, options = {}) {
  return ssh("sudo bash -s", {
    sensitive: true,
    ...options,
    input: "set -euo pipefail\numask 077\n" + script + "\n",
  });
}

async function verifyAdmission(deployment) {
  const resources = await tenantNodes(
    "resources",
    "id __typename address { value } remoteNetwork { id } ... on WebAppResource { gateway { id } }",
  );
  const groups = await tenantNodes(
    "groups",
    "id name users { edges { node { id } } pageInfo { hasNextPage } } resources { edges { node { id } } pageInfo { hasNextPage } }",
  );
  const group = groups.find(({ id }) => id === deployment.admin_group_id);
  if (
    !group ||
    group.name !== deployment.entry_group ||
    group.users.pageInfo.hasNextPage ||
    !group.users.edges.some(
      ({ node }) => node.id === deployment.operator_subject,
    ) ||
    groups.some((item) => item.resources.pageInfo.hasNextPage)
  ) {
    throw new Error("Dedicated admission group drift");
  }
  for (const [address, id, type] of [
    ["app.argos-poc.internal", deployment.app_resource_id, "WebAppResource"],
    ["api.argos-poc.internal", deployment.api_resource_id, "NetworkResource"],
    [
      deployment.bucket_name + ".storage.googleapis.com",
      deployment.bucket_resource_id,
      "NetworkResource",
    ],
  ]) {
    const matching = resources.filter((item) => item.address.value === address);
    const resource = matching[0];
    if (
      !id ||
      matching.length !== 1 ||
      resource.id !== id ||
      resource.__typename !== type ||
      resource.remoteNetwork.id !== deployment.remote_network_id ||
      (type === "WebAppResource" &&
        resource.gateway?.id !== deployment.gateway_id)
    ) {
      throw new Error("Owned Gateway, API or bucket Resource drift");
    }
    const grants = groups.filter((item) =>
      item.resources.edges.some(({ node }) => node.id === id),
    );
    if (grants.length !== 1 || grants[0].id !== deployment.admin_group_id) {
      throw new Error("Unexpected Resource admission grant");
    }
  }
}

async function verifyVm(outputs) {
  const deployment = outputs.deployment;
  const vm = await gcloudJson([
    "compute",
    "instances",
    "describe",
    outputs.instance_name,
    "--zone=" + outputs.zone,
  ]);
  if (
    ![
      vm.id,
      vm.selfLink,
      "projects/" +
        outputs.project_id +
        "/zones/" +
        outputs.zone +
        "/instances/" +
        outputs.instance_name,
    ].includes(deployment.vm_id) ||
    vm.networkInterfaces.length !== 1 ||
    vm.networkInterfaces[0].networkIP !== deployment.private_ip ||
    !vm.networkInterfaces[0].network.endsWith(
      "/projects/" +
        outputs.project_id +
        "/global/networks/" +
        deployment.network_id.split("/").at(-1),
    ) ||
    vm.networkInterfaces.some((item) => item.accessConfigs?.length) ||
    vm.labels?.deployment !== "argos-poc" ||
    vm.labels?.keep !== "true" ||
    vm.labels?.owner !== "matt-demichele" ||
    vm.serviceAccounts?.length !== 1 ||
    vm.serviceAccounts[0].email !== deployment.runtime_service_account
  ) {
    throw new Error("Live VM ownership/private ingress drift");
  }
}

async function verifyImage(image) {
  const inspected = JSON.parse(
    (
      await ssh("sudo docker image inspect " + quote(image), {
        sensitive: true,
      })
    ).stdout,
  )[0];
  if (
    !inspected ||
    inspected.Id !== image ||
    inspected.Architecture !== "amd64" ||
    inspected.Os !== "linux"
  ) {
    throw new Error("Requested linux/amd64 image is not loaded unchanged");
  }
}

async function checkCompose() {
  const model = JSON.parse(
    (
      await run("docker", [
        "compose",
        "--project-directory",
        ROOT,
        "-f",
        join(ROOT, "compose.yaml"),
        "config",
        "--no-interpolate",
        "--no-normalize",
        "--no-path-resolution",
        "--no-env-resolution",
        "--format",
        "json",
      ])
    ).stdout,
  );
  if (
    Object.values(model.services).some(
      (service) => service.ports?.length || service.network_mode === "host",
    )
  ) {
    throw new Error(
      "Release may not publish host ports or use host networking",
    );
  }
  for (const name of ["web", "worker", "migrate", "bootstrap"]) {
    if (model.services[name].pull_policy !== "never") {
      throw new Error("Application immutable image pull guard missing");
    }
  }
}

async function readActiveRelease() {
  try {
    return await jsonFile(join(STATE, "release.json"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readPins(remotePins) {
  const pins = await readProtectedJson(join(STATE, "secret-versions.json"));
  if (!PIN_KEYS.every((key) => VERSION.test(pins[key] ?? ""))) {
    throw new Error("Missing numeric secret pins");
  }
  if (remotePins) {
    if (PIN_KEYS.some((key) => remotePins[key] !== pins[key])) {
      throw new Error(
        "Active release secret pins differ from protected local state",
      );
    }
  }
  return pins;
}

async function assertRuntimeCandidate(version, activeVersion, vmId) {
  if (version === activeVersion) {
    return;
  }
  const candidates = await readProtectedJson(
    join(STATE, "runtime-candidates.json"),
  );
  if (
    !candidates.some(
      (item) =>
        item.version === version &&
        item.fromVersion === activeVersion &&
        item.vmId === vmId,
    )
  ) {
    throw new Error("Runtime version is not an owned staged candidate");
  }
}

async function assertRuntimeEntryGroup(version, entryGroup) {
  const runtime = await readRuntimeVersion(version);
  if (runtime.TWINGATE_GATEWAY_ENTRY_GROUP !== entryGroup) {
    throw new Error(
      `Runtime version ${version} admits a different group than Terraform's entry_group. Stage one with: secrets.mjs stage-runtime --from-version ${version}`,
    );
  }
}

async function uploadArchive(path, bucket) {
  const archive = await assertPrivateFile(path, "Image archive");
  const [hash] = (await run("shasum", ["-a", "256", archive])).stdout.split(
    /\s/,
  );
  const object = `gs://${bucket}/images/sha256-${hash}`;
  await gcloud(["storage", "cp", "--no-clobber", archive, object], {
    sensitive: true,
  });
  return { object, sha256: hash };
}

async function loadArchive(path, bucket) {
  const { object, sha256: hash } = await uploadArchive(path, bucket);
  await remote(
    "download=$(mktemp /tmp/argos-poc-image.XXXXXX)\n" +
      `trap 'rm -f "$download"' EXIT\n` +
      `gcloud storage cp --quiet ${quote(object)} "$download"\n` +
      `test "$(sha256sum "$download" | cut -d' ' -f1)" = ${quote(hash)}\n` +
      'docker load -i "$download" >/dev/null',
  );
}

async function uploadRelease(id, files) {
  const local = join(STATE, "releases", id);
  for (const [name, text] of Object.entries(files)) {
    await privateWrite(join(local, name), text);
  }
  const upload = "/tmp/argos-poc-" + id;
  await gcloud(
    [
      "compute",
      "scp",
      "--recurse",
      local,
      "argos-poc:" + upload,
      "--zone=" + ZONE,
      "--tunnel-through-iap",
    ],
    { sensitive: true },
  );
  await rm(local, { recursive: true });
  const path = "/srv/argos-poc/releases/" + id;
  await remote(
    `mv -T ${quote(upload)} ${quote(path)}\n` +
      `chown -R root:root ${quote(path)}\n` +
      `chmod -R go-rwx ${quote(path)}\n` +
      // Gateway runs as 65532 and reads its configuration through a bind mount.
      `chmod 0644 ${quote(path + "/gateway.yaml")}`,
  );
  return path;
}

async function agentStatus(bucket) {
  const result = await gcloud(
    ["storage", "cat", `gs://${bucket}/status/agent.json`],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    if (/matched no objects/.test(result.stderr)) {
      return null;
    }
    throw new Error("Cannot read the release agent status: " + result.stderr);
  }
  return JSON.parse(result.stdout);
}

async function idleAgent(bucket) {
  const status = await agentStatus(bucket);
  if (!status || status.state === "applying" || !RELEASE.test(status.current)) {
    throw new Error("The release agent is not idle on an installed release");
  }
  return status;
}

async function publishRelease({ id, bucket, from, image, archive, files }) {
  const manifest = JSON.stringify({
    id,
    from,
    image,
    archive: archive ? await uploadArchive(archive, bucket) : null,
    files,
  });
  const object = `gs://${bucket}/releases/${id}.json`;
  await gcloud(["storage", "cp", "--no-clobber", "-", object], {
    input: manifest,
  });
  await gcloud(["storage", "cp", "-", `gs://${bucket}/current.json`], {
    input: JSON.stringify({
      id,
      manifest: object,
      sha256: createHash("sha256").update(manifest).digest("hex"),
    }),
  });
  console.log(`Published release ${id}; waiting for the VM to apply it.`);
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const status = await agentStatus(bucket);
    if (status?.id === id && status.state === "applied") {
      return status;
    }
    if (status?.id === id && status.state === "failed") {
      throw new Error("Release agent failed: " + status.error);
    }
    if (Date.now() > deadline) {
      throw new Error("Release agent did not finish within 30 minutes");
    }
    await sleep(10_000);
  }
}

async function releaseFiles(image, pins) {
  const { images } = await imageManifest();
  const files = {
    "images.env": envText({ ...images, ARGOS_IMAGE: image }),
    "release.env": envText(pins),
  };
  for (const name of RELEASE_FILES) {
    files[name] = await readFile(join(ROOT, name), "utf8");
  }
  return files;
}

const newReleaseId = () =>
  new Date().toISOString().replaceAll(/[^0-9]/g, "") +
  "-" +
  randomBytes(4).toString("hex");

// CI has no Terraform outputs, Twingate token or protected local state: it
// ships a new image on the pins the VM already runs. Secret and TLS rotations
// stay with the operator's update.
async function deployFromCi({ image, archive }) {
  await checkCompose();
  const status = await idleAgent(RELEASES_BUCKET);
  const id = newReleaseId();
  const applied = await publishRelease({
    id,
    bucket: RELEASES_BUCKET,
    from: status.current,
    image,
    archive,
    files: await releaseFiles(image, status.pins),
  });
  console.log(
    JSON.stringify({
      release: applied.current,
      image,
      backup: applied.backup,
    }),
  );
}

async function install(
  deployment,
  { id, image, archive, files, pins, runtimeVersion },
) {
  if (archive) {
    await loadArchive(archive, deployment.releases_bucket);
  }
  await verifyImage(image);
  const path = await uploadRelease(id, files);
  const command = compose(path);
  await remote(
    `${LOAD_SECRETS} --release ${quote(path)}\n` +
      `${command} --profile migrate run --rm -T migrate`,
  );
  const { userId, teamAccountId, projectId } = await bootstrap(path, {
    email: OPERATOR_EMAIL,
    name: "Argos administrator",
  });
  await provisionIdentity(path, {
    subject: deployment.operator_subject,
    userId,
  });
  const { version } = await stageRuntime({
    fromVersion: runtimeVersion,
    patch: {
      TWINGATE_GATEWAY_ENROLLMENT_ENABLED: "true",
      TWINGATE_GATEWAY_ENROLLMENT_TEAM_ACCOUNT_ID: teamAccountId,
      TWINGATE_GATEWAY_ENROLLMENT_REVIEWER_PROJECT_IDS: projectId,
    },
  });
  pins.RUNTIME_SECRET_VERSION = version;
  await remote(
    `printf '%s' ${quote(envText(pins))} > ${quote(path + "/release.env")}\n` +
      `${LOAD_SECRETS} --release ${quote(path)}\n` +
      `${command} up -d --wait\n` +
      `ln -sfn ${quote(path)} /srv/argos-poc/current.next\n` +
      "mv -Tf /srv/argos-poc/current.next /srv/argos-poc/current\n" +
      "systemctl start argos-poc.service",
  );
  return path;
}

await entry(async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: "string" },
      "runtime-version": { type: "string" },
      archive: { type: "string" },
      "tls-version": { type: "string" },
    },
  });
  const [action] = positionals;
  const {
    image = "",
    "runtime-version": runtimeVersion = "",
    archive,
    "tls-version": tlsVersion,
  } = values;
  if (
    action === "ci" &&
    positionals.length === 1 &&
    IMAGE.test(image) &&
    archive &&
    !runtimeVersion &&
    !tlsVersion
  ) {
    await deployFromCi({ image, archive });
    return;
  }
  if (
    positionals.length !== 1 ||
    !["install", "update"].includes(action) ||
    !IMAGE.test(image) ||
    !VERSION.test(runtimeVersion) ||
    (tlsVersion !== undefined &&
      (action !== "update" || !VERSION.test(tlsVersion)))
  ) {
    throw new Error(USAGE);
  }
  const initial = action === "install";

  const outputs = await deploymentOutputs();
  const { deployment } = outputs;
  await verifyVm(outputs);
  await verifyAdmission(deployment);

  const active = await readActiveRelease();
  if (initial ? active : !active || active.vmId !== deployment.vm_id) {
    throw new Error("Installation/release ownership guard failed");
  }
  let status = null;
  if (initial) {
    await verifyStorageBoundary(outputs);
    const host = await remote(
      "mountpoint -q /srv/argos-poc\ntest -f /var/lib/argos-poc/initialized\n" +
        "test ! -e /srv/argos-poc/current",
      { allowFailure: true },
    );
    if (host.code !== 0) {
      throw new Error(
        "The VM is not initialized or already has a current release",
      );
    }
  } else {
    status = await idleAgent(deployment.releases_bucket);
  }

  const pins = await readPins(status?.pins);
  await assertRuntimeCandidate(
    runtimeVersion,
    pins.RUNTIME_SECRET_VERSION,
    deployment.vm_id,
  );
  await assertRuntimeEntryGroup(runtimeVersion, deployment.entry_group);
  pins.RUNTIME_SECRET_VERSION = runtimeVersion;
  if (tlsVersion !== undefined) {
    await readTlsCandidate(tlsVersion, pins.TLS_SECRET_VERSION);
    pins.TLS_SECRET_VERSION = tlsVersion;
  }
  await checkCompose();

  const id = newReleaseId();
  const files = await releaseFiles(image, pins);

  let path;
  let backup = null;
  if (initial) {
    path = await install(deployment, {
      id,
      image,
      archive,
      files,
      pins,
      runtimeVersion,
    });
  } else {
    const applied = await publishRelease({
      id,
      bucket: deployment.releases_bucket,
      from: status.current,
      image,
      archive,
      files,
    });
    path = applied.current;
    backup = applied.backup;
  }
  await save("secret-versions.json", pins);
  await save("release.json", { release: path, image, vmId: deployment.vm_id });
  console.log(
    JSON.stringify({
      release: path,
      image,
      runtimeVersion: pins.RUNTIME_SECRET_VERSION,
      backup,
    }),
  );
});
