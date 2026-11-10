import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  privateDir,
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
  readTlsCandidate,
  stageRuntime,
} from "./secrets.mjs";

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[1-9][0-9]*$/;
const RELEASE = /^\/srv\/argos-poc\/releases\/[0-9]+-[a-f0-9]+$/;
const INFRASTRUCTURE = [
  "postgres",
  "redis",
  "rabbitmq",
  "connector",
  "gateway",
  "app-proxy",
  "api-proxy",
];
const IMAGE_KEYS = {
  postgres: "POSTGRES_IMAGE",
  redis: "REDIS_IMAGE",
  rabbitmq: "RABBITMQ_IMAGE",
  connector: "CONNECTOR_IMAGE",
  gateway: "GATEWAY_IMAGE",
  "app-proxy": "NGINX_IMAGE",
  "api-proxy": "NGINX_IMAGE",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const save = (name, value) =>
  privateWrite(join(STATE, name), JSON.stringify(value, null, 2) + "\n");
const runner = "/usr/local/lib/argos-poc/run-release.sh";
const marker = "/srv/argos-poc/cutover-in-progress";
const CLOSED_SERVICES = ["web", "worker", "app-proxy", "api-proxy"];

function transitionFor(record) {
  return {
    candidateRelease: record.path,
    previousRelease: record.previous?.release ?? null,
    initial: record.initial,
    vmId: record.vmId,
    intentId: record.id,
  };
}

function markerGuard(record) {
  return (
    "python3 -c " +
    quote(
      "import json; assert json.load(open(" +
        JSON.stringify(marker) +
        ")) == json.loads(" +
        JSON.stringify(JSON.stringify(transitionFor(record))) +
        ")",
    )
  );
}

function ownershipGuard(record) {
  return record.initial
    ? "test ! -e /srv/argos-poc/current"
    : 'test "$(readlink -f /srv/argos-poc/current)" = ' +
        quote(record.previous.release);
}

function closeIngress() {
  return (
    "for name in " +
    CLOSED_SERVICES.join(" ") +
    "; do if docker inspect argos-poc-$name-1 >/dev/null 2>&1; then docker update --restart=no argos-poc-$name-1 >/dev/null; fi; done\n"
  );
}

async function reconcileStaging(record) {
  const identity = JSON.stringify(transitionFor(record));
  const owner = record.path + "/intent.json";
  const currentGuard = record.applicationPrepared
    ? 'if test "$(readlink -f /srv/argos-poc/current)" != ' +
      quote(record.path) +
      "; then\n" +
      ownershipGuard(record) +
      "\nfi"
    : ownershipGuard(record);
  const existing = await locked(
    "mountpoint -q /srv/argos-poc\ntest -f /var/lib/argos-poc/initialized\n" +
      "if test -e " +
      quote(marker) +
      "; then\n" +
      markerGuard(record) +
      "\n" +
      currentGuard +
      "\n" +
      'test "$(cat ' +
      quote(owner) +
      ')" = ' +
      quote(identity) +
      "\nprintf marked\n" +
      'elif test "$(readlink -f /srv/argos-poc/current)" = ' +
      quote(record.path) +
      "; then\n" +
      'test "$(cat ' +
      quote(owner) +
      ')" = ' +
      quote(identity) +
      "\nprintf committed\n" +
      "else\n" +
      ownershipGuard(record) +
      "\nprintf staging\nfi",
  );
  if (existing.stdout === "committed") {
    if (!record.applicationPrepared) {
      throw new Error("Unprepared candidate became current");
    }
    return;
  }
  if (existing.stdout === "marked") {
    return;
  }
  for (const [name, hash] of Object.entries(record.files)) {
    if (sha256(await readFile(join(record.local, name))) !== hash) {
      throw new Error("Owned local staging files changed");
    }
  }
  const upload =
    "/tmp/argos-poc-" + record.id + "-" + randomBytes(8).toString("hex");
  await gcloud(
    [
      "compute",
      "scp",
      "--recurse",
      record.local,
      "argos-poc:" + upload,
      "--zone=" + ZONE,
      "--tunnel-through-iap",
    ],
    { sensitive: true },
  );
  await locked(
    "mountpoint -q /srv/argos-poc\ntest -f /var/lib/argos-poc/initialized\n" +
      "test ! -e " +
      quote(marker) +
      "\n" +
      ownershipGuard(record) +
      "\nif test ! -e " +
      quote(record.path) +
      "; then\n" +
      "temporary=$(mktemp -d /srv/argos-poc/releases/.install-XXXXXXXX)\n" +
      "printf '%s\\n' " +
      quote(identity) +
      ' > "$temporary/intent.json"\n' +
      'chmod 0600 "$temporary/intent.json"\nmv -T "$temporary" ' +
      quote(record.path) +
      "\nfi\n" +
      'test "$(cat ' +
      quote(owner) +
      ')" = ' +
      quote(identity) +
      "\n" +
      "cp -R " +
      quote(upload + "/.") +
      " " +
      quote(record.path + "/") +
      "\nchown -R root:root " +
      quote(record.path) +
      "\nchmod -R go-rwx " +
      quote(record.path) +
      "\nchmod 0644 " +
      quote(record.path + "/gateway.yaml") +
      "\n" +
      "python3 -c " +
      quote(
        "import hashlib,json,pathlib; root=pathlib.Path(" +
          JSON.stringify(record.path) +
          "); expected=json.loads(" +
          JSON.stringify(JSON.stringify(record.files)) +
          "); assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==digest for name,digest in expected.items())",
      ) +
      "\n" +
      "sync -f " +
      quote(record.path) +
      "\n" +
      (record.initial
        ? 'test -z "$(docker ps -aq --filter label=com.docker.compose.project=argos-poc)"\ntest -z "$(find /srv/argos-poc/data -mindepth 2 -print -quit)"\n'
        : closeIngress() + "sync -f /var/lib/docker\n") +
      "python3 -c " +
      quote(
        "import os; p=" +
          JSON.stringify(marker) +
          "; f=open(p+'.new','w'); f.write(" +
          JSON.stringify(identity + "\n") +
          "); f.flush(); os.fsync(f.fileno()); f.close(); os.chmod(p+'.new',0o600); os.replace(p+'.new',p); d=os.open('/srv/argos-poc',os.O_DIRECTORY); os.fsync(d); os.close(d)",
      ) +
      "\n" +
      (record.initial
        ? ""
        : compose(record.previous.release) +
          " stop app-proxy api-proxy web worker\n") +
      "rm -rf " +
      quote(upload),
  );
}

async function recoverDocker(record) {
  await locked(
    markerGuard(record) +
      "\n" +
      "python3 -c " +
      quote(
        "import hashlib,json,os,pathlib; marker=pathlib.Path(" +
          JSON.stringify(marker) +
          "); release=pathlib.Path(" +
          JSON.stringify(record.path) +
          "); expected=json.loads(" +
          JSON.stringify(JSON.stringify(transitionFor(record))) +
          "); assert json.loads((release/'intent.json').read_text())==expected; " +
          "authorization={'candidateRelease':str(release),'markerSha256':hashlib.sha256(marker.read_bytes()).hexdigest(),'releaseSha256':hashlib.sha256((release/'release.env').read_bytes()).hexdigest()}; " +
          "p=pathlib.Path('/run/argos-poc/recovery.json'); p.write_text(json.dumps(authorization)); p.chmod(0o600)",
      ) +
      "\n/usr/local/lib/argos-poc/load-secrets.py --prepare\n" +
      "systemctl reset-failed argos-poc-prepare.service docker.service\n" +
      "systemctl start docker.service\n" +
      closeIngress() +
      compose(record.path) +
      " stop app-proxy api-proxy web worker\n",
  );
}

async function recreateTlsInfrastructure(record) {
  const command = compose(record.path);
  const baseline = record.originalInfrastructure;
  await locked(
    markerGuard(record) +
      "\npython3 - " +
      quote(record.path) +
      " <<'VERIFY_TLS_OWNERSHIP'\n" +
      [
        "import json,subprocess,sys",
        "release=sys.argv[1]",
        "expected=json.loads(" + JSON.stringify(JSON.stringify(baseline)) + ")",
        "prefix=['docker','compose','--project-name','argos-poc','--project-directory',release,'-f',release+'/compose.yaml','--env-file',release+'/images.env','--env-file',release+'/release.env','--env-file','/run/argos-poc/runtime.env','--env-file','/run/argos-poc/connector.env']",
        "hashes=dict(line.split() for line in subprocess.check_output(prefix+['config','--hash','*'],text=True).splitlines())",
        "for item in expected['services']:",
        " name=item['name']",
        " observed=subprocess.run(['docker','inspect','argos-poc-'+name+'-1'],capture_output=True,text=True)",
        " if observed.returncode:",
        "  assert name in {'gateway','app-proxy','api-proxy'}",
        "  continue",
        " container=json.loads(observed.stdout)[0]",
        " assert container['Config']['Image']==item['image'] and not container['HostConfig'].get('PortBindings')",
        " if container['Id']==item['id']:",
        "  assert container['Config']['Labels']['com.docker.compose.config-hash']==item['configHash']",
        " else:",
        "  assert name in {'gateway','app-proxy','api-proxy'}",
        "  labels=container['Config']['Labels']",
        "  assert labels['com.docker.compose.project']=='argos-poc' and labels['com.docker.compose.service']==name",
        "  assert labels['com.docker.compose.project.working_dir']==release and labels['com.docker.compose.config-hash']==hashes[name]",
      ].join("\n") +
      "\nVERIFY_TLS_OWNERSHIP\n" +
      command +
      " up -d --no-deps --force-recreate --wait gateway\n" +
      command +
      " up --no-start --no-deps --force-recreate app-proxy api-proxy\n" +
      closeIngress(),
  );
  const infrastructure = await captureInfrastructure(
    record.path,
    record.images,
  );
  for (const original of baseline.services.filter(
    ({ name }) => !["gateway", "app-proxy", "api-proxy"].includes(name),
  )) {
    const current = infrastructure.services.find(
      ({ name }) => name === original.name,
    );
    if (JSON.stringify(current) !== JSON.stringify(original)) {
      throw new Error(
        "TLS maintenance changed a persistent infrastructure container",
      );
    }
  }
  record.infrastructure = infrastructure;
  const text = JSON.stringify(infrastructure, null, 2) + "\n";
  await privateWrite(join(record.local, "infrastructure-hashes.json"), text);
  await installFile(record.path + "/infrastructure-hashes.json", text);
}

async function locked(script) {
  return ssh("sudo bash -s", {
    sensitive: true,
    input:
      "set -euo pipefail\ninstall -d -m 0700 /run/argos-poc\nexec 9>/run/argos-poc/release.lock\nflock -n 9\n" +
      script +
      "\n",
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
    group.name !== "argos-poc-admins" ||
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

async function captureInfrastructure(path, images) {
  const containers = JSON.parse(
    (
      await ssh(
        "sudo docker inspect " +
          INFRASTRUCTURE.map((name) => "argos-poc-" + name + "-1").join(" "),
        { sensitive: true },
      )
    ).stdout,
  );
  const services = [];
  const proxyMounts = [];
  for (const [index, name] of INFRASTRUCTURE.entries()) {
    const container = containers[index];
    if (
      container.Config.Image !== images[IMAGE_KEYS[name]] ||
      Object.keys(container.HostConfig.PortBindings ?? {}).length ||
      !container.Config.Labels["com.docker.compose.config-hash"]
    ) {
      throw new Error("Infrastructure image/published-port guard failed");
    }
    services.push({
      name,
      id: container.Id,
      configHash: container.Config.Labels["com.docker.compose.config-hash"],
      image: container.Config.Image,
    });
    if (["gateway", "app-proxy", "api-proxy"].includes(name)) {
      const target =
        name === "gateway"
          ? "/etc/argos-poc/gateway.yaml"
          : "/etc/nginx/conf.d/default.conf";
      const relative =
        name === "gateway"
          ? "gateway.yaml"
          : "nginx/" + name.replace("-proxy", "") + ".conf";
      const mount = container.Mounts.find(
        (item) => item.Destination === target,
      );
      if (!mount || mount.RW || mount.Source !== path + "/" + relative) {
        throw new Error("Unexpected initial proxy mount");
      }
      const text = (
        await ssh("sudo cat " + quote(mount.Source), { sensitive: true })
      ).stdout;
      if (
        text !==
        (await readFile(
          join(STATE, "releases", path.split("/").at(-1), relative),
          "utf8",
        ))
      ) {
        throw new Error("Initial proxy content drift");
      }
      proxyMounts.push({
        name,
        id: container.Id,
        source: mount.Source,
        target,
        sha256: sha256(text),
      });
    }
  }
  return { services, proxyMounts };
}

async function installFile(path, content) {
  await locked(
    "python3 -c " +
      quote(
        "import json,os,pathlib; p=pathlib.Path(" +
          JSON.stringify(path) +
          "); assert json.load(open(" +
          JSON.stringify(marker) +
          "))['candidateRelease']==str(p.parent); " +
          "f=open(str(p)+'.new','w'); f.write(" +
          JSON.stringify(content) +
          "); f.flush(); os.fsync(f.fileno()); f.close(); os.chmod(str(p)+'.new',0o600); os.replace(str(p)+'.new',p); " +
          "d=os.open(p.parent,os.O_DIRECTORY); os.fsync(d); os.close(d)",
      ),
  );
}

async function backupDatabase(record, markerCheck) {
  const backup = "/srv/argos-poc/backups/" + record.id + ".dump";
  const partial = backup + ".partial";
  const command = compose(record.path);
  await locked(
    markerCheck +
      "\ninstall -d -m 0700 /srv/argos-poc/backups\n" +
      "if test ! -e " +
      quote(backup) +
      "; then\n" +
      command +
      " exec -T postgres sh -c " +
      quote('pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"') +
      " > " +
      quote(partial) +
      "\nchmod 0600 " +
      quote(partial) +
      "\n" +
      command +
      " exec -T postgres pg_restore --list < " +
      quote(partial) +
      " >/dev/null\nsync -f " +
      quote(partial) +
      "\nmv -T " +
      quote(partial) +
      " " +
      quote(backup) +
      "\nsync -f /srv/argos-poc/backups\nfi",
  );
  return backup;
}

async function activate(record, outputs) {
  if (
    record.vmId !== outputs.deployment.vm_id ||
    !RELEASE.test(record.path) ||
    record.path !== "/srv/argos-poc/releases/" + record.id ||
    record.local !== join(STATE, "releases", record.id) ||
    !record.files ||
    !Object.keys(record.files).length
  ) {
    throw new Error("Deployment intent identity drift");
  }
  await reconcileStaging(record);
  const path = record.path;
  const command = compose(path);
  const committed =
    (
      await ssh(
        "sudo test ! -e " +
          quote(marker) +
          ' && test "$(sudo readlink -f /srv/argos-poc/current)" = ' +
          quote(path),
        { sensitive: true, allowFailure: true },
      )
    ).code === 0;
  if (committed && record.applicationPrepared) {
    await locked(
      "test ! -e " +
        quote(marker) +
        "\nsystemctl start docker.service\n" +
        "docker update --restart=unless-stopped " +
        CLOSED_SERVICES.map((name) => "argos-poc-" + name + "-1").join(" ") +
        " >/dev/null",
    );
    await save("secret-versions.json", record.pins);
    await verifyImage(record.image);
    await ssh(
      "sudo " + runner + " start && sudo systemctl start argos-poc.service",
      { sensitive: true },
    );
    record.phase = "active";
    await save("deploy-intent.json", record);
    console.log(
      JSON.stringify({
        release: path,
        image: record.image,
        runtimeVersion: record.pins.RUNTIME_SECRET_VERSION,
      }),
    );
    return;
  }
  const markerCheck = markerGuard(record);
  if (record.tlsMaintenance) {
    const candidate = await readTlsCandidate(
      record.pins.TLS_SECRET_VERSION,
      record.sourceTlsVersion,
    );
    if (JSON.stringify(candidate) !== JSON.stringify(record.tlsMaintenance)) {
      throw new Error("TLS maintenance candidate changed");
    }
  }
  await recoverDocker(record);
  await verifyImage(record.image);
  if (record.infrastructure) {
    const preserved = (
      record.tlsMaintenance
        ? record.originalInfrastructure
        : record.infrastructure
    ).services.filter(
      ({ name }) =>
        !record.tlsMaintenance ||
        !["gateway", "app-proxy", "api-proxy"].includes(name),
    );
    await locked(
      markerCheck +
        "\npython3 - <<'VERIFY_PRESERVED'\n" +
        "import json,subprocess\n" +
        "expected=json.loads(" +
        JSON.stringify(JSON.stringify(preserved)) +
        ")\n" +
        "for item in expected:\n" +
        " container=json.loads(subprocess.check_output(['docker','inspect','argos-poc-'+item['name']+'-1']))[0]\n" +
        " assert container['Id']==item['id'] and container['Config']['Image']==item['image']\n" +
        " assert container['Config']['Labels']['com.docker.compose.config-hash']==item['configHash'] and not container['HostConfig'].get('PortBindings')\n" +
        "VERIFY_PRESERVED",
    );
  }
  if (!record.infrastructureReady) {
    await locked(
      markerCheck +
        "\n" +
        (record.initial
          ? command +
            " pull " +
            INFRASTRUCTURE.join(" ") +
            "\n" +
            command +
            " up -d --no-recreate --wait postgres redis rabbitmq connector gateway\n" +
            command +
            " create --no-recreate app-proxy api-proxy\n" +
            closeIngress()
          : ""),
    );
    if (record.tlsMaintenance) {
      await recreateTlsInfrastructure(record);
    }
    record.infrastructureReady = true;
    await save("deploy-intent.json", record);
  }
  await locked(
    markerCheck +
      "\n" +
      command +
      " up -d --no-deps --no-recreate --wait postgres redis rabbitmq connector gateway",
  );
  if (!record.applicationPrepared) {
    if (!record.tlsMaintenance) {
      if (!record.initial && !record.backup) {
        record.backup = await backupDatabase(record, markerCheck);
        await save("deploy-intent.json", record);
      }
      await locked(
        markerCheck +
          "\n" +
          command +
          " --profile migrate run --rm --no-deps -T migrate",
      );
    }
    if (record.initial) {
      const credentials = await bootstrap(path, {
        email: OPERATOR_EMAIL,
        name: "Argos administrator",
      });
      await provisionIdentity(path, {
        subject: outputs.deployment.operator_subject,
        userId: credentials.userId,
      });
      const staged = await stageRuntime({
        fromVersion: record.sourceRuntimeVersion,
        patch: {
          TWINGATE_GATEWAY_ENROLLMENT_ENABLED: "true",
          TWINGATE_GATEWAY_ENROLLMENT_TEAM_ACCOUNT_ID:
            credentials.teamAccountId,
          TWINGATE_GATEWAY_ENROLLMENT_REVIEWER_PROJECT_IDS:
            credentials.projectId,
        },
      });
      record.pins.RUNTIME_SECRET_VERSION = staged.version;
      const text = envText(record.pins);
      await privateWrite(join(record.local, "release.env"), text);
      await installFile(path + "/release.env", text);
      await locked(
        markerCheck +
          "\n/usr/local/lib/argos-poc/load-secrets.py --release " +
          quote(path),
      );
    }
    record.applicationPrepared = true;
    await save("deploy-intent.json", record);
  }
  if (record.initial && !record.infrastructure) {
    record.infrastructure = await captureInfrastructure(path, record.images);
    const text = JSON.stringify(record.infrastructure, null, 2) + "\n";
    await privateWrite(join(record.local, "infrastructure-hashes.json"), text);
    await installFile(path + "/infrastructure-hashes.json", text);
    await save("deploy-intent.json", record);
  }
  // Existing infrastructure is never recreated during application cutover.
  await ssh(
    "sudo env ARGOS_POC_CUTOVER=1 " +
      runner +
      " --release " +
      quote(path) +
      " start",
    { sensitive: true },
  );
  await locked(
    markerCheck +
      "\n" +
      command +
      " up -d --no-deps --no-recreate --wait app-proxy api-proxy\n" +
      "ln -sfn " +
      quote(path) +
      " /srv/argos-poc/current.next\nmv -Tf /srv/argos-poc/current.next /srv/argos-poc/current\n",
  );
  await save("release.json", {
    release: path,
    image: record.image,
    vmId: record.vmId,
  });
  await locked(
    markerCheck +
      "\npython3 -c " +
      quote(
        "import os; os.unlink(" +
          JSON.stringify(marker) +
          "); d=os.open('/srv/argos-poc',os.O_DIRECTORY); os.fsync(d); os.close(d)",
      ) +
      "\nrm -f /run/argos-poc/recovery.json\n" +
      "docker update --restart=unless-stopped " +
      CLOSED_SERVICES.map((name) => "argos-poc-" + name + "-1").join(" ") +
      " >/dev/null",
  );
  await save("secret-versions.json", record.pins);
  await ssh(
    "sudo " + runner + " start && sudo systemctl start argos-poc.service",
    { sensitive: true },
  );
  record.phase = "active";
  await save("deploy-intent.json", record);
  console.log(
    JSON.stringify({
      release: path,
      image: record.image,
      runtimeVersion: record.pins.RUNTIME_SECRET_VERSION,
    }),
  );
}

await entry(async () => {
  const [action, ...args] = process.argv.slice(2);
  const outputs = await deploymentOutputs();
  await verifyVm(outputs);
  await verifyStorageBoundary(outputs);
  await verifyAdmission(outputs.deployment);
  if (action === "resume" && args.length === 0) {
    const record = await readProtectedJson(join(STATE, "deploy-intent.json"));
    if (record.phase === "active") {
      throw new Error("Deployment is already active");
    }
    await activate(record, outputs);
    return;
  }
  const options = {};
  if (args.length % 2) {
    throw new Error("Deployment options require values");
  }
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--image", "--runtime-version", "--archive", "--tls-version"].includes(
        args[index],
      ) ||
      options[args[index]]
    ) {
      throw new Error("Unknown or duplicate deployment option");
    }
    options[args[index]] = args[index + 1];
  }
  const image = options["--image"];
  const version = options["--runtime-version"];
  const tlsVersion = options["--tls-version"];
  if (
    !["install", "update"].includes(action) ||
    !IMAGE.test(image ?? "") ||
    !VERSION.test(version ?? "") ||
    (tlsVersion !== undefined &&
      (action !== "update" || !VERSION.test(tlsVersion)))
  ) {
    throw new Error(
      "Usage: deploy.mjs install|update --image sha256:<image-id> --runtime-version <N> [--archive <protected-tar>] [--tls-version <N> (update maintenance only)] | resume",
    );
  }
  const initial = action === "install";
  let active;
  try {
    active = await jsonFile(join(STATE, "release.json"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    initial
      ? Boolean(active)
      : !active ||
        active.vmId !== outputs.deployment.vm_id ||
        !RELEASE.test(active.release)
  ) {
    throw new Error("Installation/release ownership guard failed");
  }
  const pins = await readProtectedJson(join(STATE, "secret-versions.json"));
  if (
    ![
      "RUNTIME_SECRET_VERSION",
      "CONNECTOR_SECRET_VERSION",
      "TLS_SECRET_VERSION",
    ].every((key) => VERSION.test(pins[key] ?? ""))
  ) {
    throw new Error("Missing numeric secret pins");
  }
  try {
    const existing = await readProtectedJson(join(STATE, "deploy-intent.json"));
    if (existing.phase !== "active") {
      throw new Error("An unfinished deployment exists; use deploy.mjs resume");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (active) {
    const remotePins = Object.fromEntries(
      (
        await ssh("sudo cat " + quote(active.release + "/release.env"), {
          sensitive: true,
        })
      ).stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    if (Object.keys(pins).some((key) => remotePins[key] !== pins[key])) {
      throw new Error(
        "Active release secret pins differ from protected local state",
      );
    }
  }
  const sourceTlsVersion = pins.TLS_SECRET_VERSION;
  let tlsMaintenance;
  if (tlsVersion !== undefined) {
    if (
      image !== active.image ||
      version !== pins.RUNTIME_SECRET_VERSION ||
      tlsVersion === sourceTlsVersion
    ) {
      throw new Error(
        "TLS maintenance must retain the active application image and runtime and select a new TLS candidate",
      );
    }
    tlsMaintenance = await readTlsCandidate(tlsVersion, sourceTlsVersion);
    pins.TLS_SECRET_VERSION = tlsVersion;
  }
  if (version !== pins.RUNTIME_SECRET_VERSION) {
    const candidates = await readProtectedJson(
      join(STATE, "runtime-candidates.json"),
    );
    if (
      !candidates.some(
        (item) =>
          item.version === version &&
          item.fromVersion === pins.RUNTIME_SECRET_VERSION &&
          item.vmId === outputs.deployment.vm_id,
      )
    ) {
      throw new Error("Runtime version is not an owned staged candidate");
    }
  }
  if (options["--archive"]) {
    const archive = await assertPrivateFile(
      options["--archive"],
      "Image archive",
    );
    const archiveHash = (
      await run("shasum", ["-a", "256", archive])
    ).stdout.split(/\s/)[0];
    await gcloud(
      [
        "compute",
        "scp",
        archive,
        "argos-poc:/tmp/argos-poc-image.tar",
        "--zone=" + ZONE,
        "--tunnel-through-iap",
      ],
      { sensitive: true },
    );
    await ssh(
      "sudo bash -c " +
        quote(
          "set -euo pipefail; test \"$(sha256sum /tmp/argos-poc-image.tar | cut -d' ' -f1)\" = " +
            quote(archiveHash) +
            "; docker load -i /tmp/argos-poc-image.tar >/dev/null; rm /tmp/argos-poc-image.tar",
        ),
      { sensitive: true },
    );
  }
  await verifyImage(image);
  if (active) {
    await ssh(
      "sudo " +
        runner +
        ' start && test "$(sudo readlink -f /srv/argos-poc/current)" = ' +
        quote(active.release),
      { sensitive: true },
    );
  }
  const manifest = await imageManifest();
  const id =
    new Date().toISOString().replaceAll(/[^0-9]/g, "") +
    "-" +
    randomBytes(4).toString("hex");
  const path = "/srv/argos-poc/releases/" + id;
  const local = await privateDir(join(STATE, "releases", id));
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
  const files = {};
  for (const name of [
    "compose.connector.yaml",
    "gateway.yaml",
    "nginx/api.conf",
    "nginx/app.conf",
  ]) {
    files[name] = await readFile(join(ROOT, name), "utf8");
  }
  let infrastructure;
  if (active) {
    const oldImages = (
      await ssh("sudo cat " + quote(active.release + "/images.env"), {
        sensitive: true,
      })
    ).stdout;
    for (const [key, value] of Object.entries(manifest.images)) {
      if (!oldImages.split("\n").includes(key + "=" + value)) {
        throw new Error(
          "Infrastructure image changes require an explicit separate maintenance operation",
        );
      }
    }
    infrastructure = JSON.parse(
      (
        await ssh(
          "sudo cat " + quote(active.release + "/infrastructure-hashes.json"),
          { sensitive: true },
        )
      ).stdout,
    );
  }
  for (const name of ["gateway", "app-proxy", "api-proxy"]) {
    const target =
      name === "gateway"
        ? "/etc/argos-poc/gateway.yaml"
        : "/etc/nginx/conf.d/default.conf";
    const relative =
      name === "gateway"
        ? "gateway.yaml"
        : "nginx/" + name.replace("-proxy", "") + ".conf";
    const volume = model.services[name].volumes.find(
      (item) => item.target === target,
    );
    if (!volume?.read_only) {
      throw new Error("Required read-only ingress mount absent");
    }
    const existing = infrastructure?.proxyMounts.find(
      (item) => item.name === name,
    );
    if (active && (!existing || existing.sha256 !== sha256(files[relative]))) {
      throw new Error(
        "Ingress configuration changes require an explicit separate maintenance operation",
      );
    }
    volume.source = tlsMaintenance
      ? path + "/" + relative
      : (existing?.source ?? path + "/" + relative);
  }
  for (const name of ["web", "worker", "migrate", "bootstrap"]) {
    if (model.services[name].pull_policy !== "never") {
      throw new Error("Application immutable image pull guard missing");
    }
  }
  pins.RUNTIME_SECRET_VERSION = version;
  files["compose.yaml"] = JSON.stringify(model, null, 2) + "\n";
  files["images.env"] = envText({ ...manifest.images, ARGOS_IMAGE: image });
  files["release.env"] = envText(pins);
  files["cutover.compose.yaml"] =
    JSON.stringify(
      { services: { web: { restart: "no" }, worker: { restart: "no" } } },
      null,
      2,
    ) + "\n";
  if (infrastructure) {
    files["infrastructure-hashes.json"] =
      JSON.stringify(infrastructure, null, 2) + "\n";
  }
  for (const [name, text] of Object.entries(files)) {
    await privateWrite(join(local, name), text);
  }
  const record = {
    id,
    path,
    local,
    initial,
    vmId: outputs.deployment.vm_id,
    image,
    pins,
    images: manifest.images,
    sourceRuntimeVersion: version,
    infrastructure,
    originalInfrastructure: infrastructure,
    sourceTlsVersion,
    tlsMaintenance,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, sha256(text)]),
    ),
    previous: active ?? null,
    phase: "staged",
    createdAt: new Date().toISOString(),
  };
  await save("deploy-intent.json", record);
  await activate(record, outputs);
});
