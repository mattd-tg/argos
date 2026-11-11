import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  gcloud,
  gcloudJson,
  OPERATOR_EMAIL,
  OPERATOR_SUBJECT,
  PROJECT,
  PROJECT_NUMBER,
  ROOT,
  run,
  STATE,
  tenantNodes,
  tenantQuery,
} from "./lib.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ownedState(scope) {
  if (scope === "bootstrap") {
    try {
      return JSON.parse(
        await readFile(join(STATE, "bootstrap.tfstate"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }
  const result = await run(
    "mise",
    [
      "exec",
      "terraform@1.12.1",
      "--",
      "terraform",
      "-chdir=" + join(ROOT, "terraform"),
      "show",
      "-json",
    ],
    {
      env: { TF_DATA_DIR: join(STATE, "terraform-data/main") },
      sensitive: true,
    },
  );
  return JSON.parse(result.stdout || "{}");
}

function stateResources(state) {
  if (state.resources) {
    return state.resources.flatMap(
      (resource) =>
        resource.instances?.map((instance) => ({
          type: resource.type,
          values: instance.attributes,
        })) ?? [],
    );
  }
  const walk = (module) => [
    ...(module?.resources ?? []),
    ...(module?.child_modules ?? []).flatMap(walk),
  ];
  return walk(state.values?.root_module);
}

export async function checkProvisioningPermissions() {
  const token = (
    await gcloud(["auth", "application-default", "print-access-token"], {
      sensitive: true,
    })
  ).stdout.trim();
  const permissions = [
    "compute.instances.create",
    "compute.networks.create",
    "compute.subnetworks.create",
    "compute.routers.create",
    "compute.disks.create",
    "compute.firewalls.create",
    "iam.serviceAccounts.create",
    "secretmanager.secrets.create",
    "storage.buckets.create",
    "iam.workloadIdentityPools.create",
  ];
  const response = await fetch(
    "https://cloudresourcemanager.googleapis.com/v1/projects/" +
      PROJECT +
      ":testIamPermissions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "x-goog-user-project": PROJECT,
      },
      body: JSON.stringify({ permissions }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert(response.ok, "Cannot verify provisioning permissions");
  const granted = (await response.json()).permissions ?? [];
  const missing = permissions.filter(
    (permission) => !granted.includes(permission),
  );
  assert(
    !missing.length,
    "Cloud mutation withheld; missing permissions: " + missing.join(", "),
  );
  const bucketName = PROJECT + "-argos-poc-state";
  const bootstrap = stateResources(await ownedState("bootstrap"));
  assert(
    bootstrap.some(
      (resource) =>
        resource.type === "google_storage_bucket" &&
        resource.values?.name === bucketName,
    ),
    "Owned bootstrap bucket is required before main provisioning",
  );
  // New buckets grant project Editors bucket-scoped rights that project permission tests cannot see.
  const bucketPermissions = [
    "storage.buckets.update",
    "storage.buckets.setIamPolicy",
    "storage.buckets.getIpFilter",
    "storage.buckets.setIpFilter",
  ];
  const query = new URLSearchParams(
    bucketPermissions.map((permission) => ["permissions", permission]),
  );
  const bucketResponse = await fetch(
    "https://storage.googleapis.com/storage/v1/b/" +
      bucketName +
      "/iam/testPermissions?" +
      query,
    {
      headers: {
        Authorization: "Bearer " + token,
        "x-goog-user-project": PROJECT,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert(bucketResponse.ok, "Cannot verify owned bucket permissions");
  const bucketGranted = (await bucketResponse.json()).permissions ?? [];
  const bucketMissing = bucketPermissions.filter(
    (permission) => !bucketGranted.includes(permission),
  );
  assert(
    !bucketMissing.length,
    "Cloud mutation withheld; missing bucket permissions: " +
      bucketMissing.join(", "),
  );
}

export async function preflight(scope = "main") {
  assert(["main", "bootstrap"].includes(scope), "Unknown preflight scope");
  const account = (
    await gcloud([
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ])
  ).stdout.trim();
  assert(account === OPERATOR_EMAIL, "Unexpected active gcloud account");
  const project = await gcloudJson(["projects", "describe", PROJECT]);
  assert(
    project.projectNumber === PROJECT_NUMBER &&
      project.lifecycleState === "ACTIVE",
    "Wrong project identity or inactive project",
  );
  await gcloud(["auth", "application-default", "print-access-token"], {
    sensitive: true,
  });
  // Provisioning does not depend on or change the native Client's active tenant.
  const users = (
    await tenantQuery(
      "{ users(first:100) { edges { node { id email } } pageInfo { hasNextPage } } }",
    )
  ).users;
  assert(
    !users.pageInfo.hasNextPage &&
      users.edges.filter(
        ({ node }) =>
          node.email === OPERATOR_EMAIL && node.id === OPERATOR_SUBJECT,
      ).length === 1,
    "Approved tenant operator identity is unavailable",
  );
  const owned = scope === "main" ? stateResources(await ownedState(scope)) : [];
  const identity = (value) =>
    value?.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, "");
  const bootDisks = owned
    .filter((resource) => resource.type === "google_compute_instance")
    .flatMap((resource) => resource.values?.boot_disk ?? [])
    .map((disk) => identity(disk.source))
    .filter(Boolean);
  const hasOwned = (type, value) =>
    (type === "google_compute_disk" && bootDisks.includes(identity(value))) ||
    owned.some(
      (resource) =>
        resource.type === type &&
        [
          resource.values?.id,
          resource.values?.name,
          resource.values?.account_id,
          resource.values?.secret_id,
        ].some(
          (name) =>
            typeof name === "string" &&
            (identity(name) === identity(value) || name.endsWith("/" + value)),
        ),
    );
  for (const [connection, type] of scope === "main"
    ? [
        ["remoteNetworks", "twingate_remote_network"],
        ["groups", "twingate_group"],
        ["connectors", "twingate_connector"],
        ["resources", "twingate_resource"],
        ["gateways", "twingate_gateway"],
        ["certificateAuthorities", "twingate_x509_certificate_authority"],
      ]
    : []) {
    const fields =
      connection === "gateways"
        ? "id address"
        : connection === "certificateAuthorities"
          ? "... on X509CertificateAuthority { id name } ... on SSHCertificateAuthority { id name }"
          : "id name";
    for (const node of await tenantNodes(connection, fields)) {
      const name = node.name ?? node.address;
      if (name?.includes("argos-poc")) {
        assert(
          hasOwned(type, node.id) ||
            hasOwned("twingate_web_app_resource", node.id),
          "Foreign Twingate name collision: " + name,
        );
      }
    }
  }
  const bootstrap = stateResources(await ownedState("bootstrap"));
  for (const [bucketName, resources] of [
    [PROJECT + "-argos-poc-state", bootstrap],
    ...(scope === "main"
      ? [
          [PROJECT + "-argos-poc-screenshots", owned],
          [PROJECT + "-argos-poc-releases", owned],
        ]
      : []),
  ]) {
    // The screenshot bucket's IP filter intentionally denies laptop metadata reads.
    // Existing state establishes ownership; Terraform performs refresh over the allowed operator path.
    if (
      resources.some(
        (resource) =>
          resource.type === "google_storage_bucket" &&
          resource.values?.name === bucketName,
      )
    ) {
      continue;
    }
    const result = await gcloud(
      ["storage", "buckets", "describe", "gs://" + bucketName, "--format=json"],
      { allowFailure: true },
    );
    if (result.code === 0) {
      throw new Error("Foreign bucket collision: " + bucketName);
    }
    assert(
      /404|not found/i.test(result.stderr),
      "Cannot establish bucket availability: " + bucketName,
    );
  }
  if (scope === "main") {
    for (const [type, command] of [
      ["google_compute_instance", ["compute", "instances", "list"]],
      ["google_compute_network", ["compute", "networks", "list"]],
      ["google_compute_subnetwork", ["compute", "networks", "subnets", "list"]],
      ["google_compute_router", ["compute", "routers", "list"]],
      ["google_compute_disk", ["compute", "disks", "list"]],
      ["google_compute_firewall", ["compute", "firewall-rules", "list"]],
      ["google_secret_manager_secret", ["secrets", "list"]],
      ["google_service_account", ["iam", "service-accounts", "list"]],
    ]) {
      for (const resource of await gcloudJson(command)) {
        const name =
          resource.email?.split("@")[0] ?? resource.name?.split("/").at(-1);
        if (name?.startsWith("argos-poc")) {
          assert(
            hasOwned(type, resource.selfLink ?? resource.name) ||
              hasOwned(type, name),
            "Foreign GCP name collision: " + name,
          );
        }
      }
    }
  }
  console.log(
    "Preflight passed: " +
      scope +
      "; project " +
      PROJECT_NUMBER +
      "; tenant argospoc; native Client unchanged.",
  );
}
