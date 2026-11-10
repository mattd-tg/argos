import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  entry,
  privateDir,
  privateWrite,
  ROOT,
  run,
  STATE,
  twingateToken,
} from "./lib.mjs";
import { checkProvisioningPermissions, preflight } from "./preflight.mjs";
import { ensurePki } from "./secrets.mjs";

const APPROVED_RESOURCES = new Set([
  "google_compute_network.network",
  "google_compute_subnetwork.subnet",
  "google_compute_router.router",
  "google_compute_router_nat.nat",
  "google_compute_firewall.iap_ssh",
  "google_compute_disk.data",
  "google_compute_instance.vm",
  "google_compute_attached_disk.data",
  "google_service_account.runtime",
  "google_service_account.storage",
  "google_storage_bucket.screenshots",
  "google_storage_bucket_iam_member.storage_objects",
  "google_secret_manager_secret.deployment",
  "google_secret_manager_secret_iam_member.runtime_accessor",
  "twingate_remote_network.argos_poc",
  "twingate_connector.argos_poc",
  "twingate_connector_tokens.argos_poc",
  "twingate_group.admins",
  "twingate_service_account.ci",
  "twingate_resource.storage",
  "twingate_resource.api",
  "twingate_x509_certificate_authority.argos_poc",
  "twingate_gateway.argos_poc",
  "twingate_web_app_resource.app_gateway",
]);

const RETIRED_RESOURCES = new Set([
  "google_artifact_registry_repository.images",
]);

const PROTECTED_TYPES =
  /^(google_compute_disk|google_secret_manager_secret|google_storage_bucket|twingate_.+)$/;

const LABELED_TYPES = new Set([
  "google_compute_disk",
  "google_compute_instance",
  "google_secret_manager_secret",
  "google_storage_bucket",
]);

function validateLabels(labels, address) {
  if (
    labels?.deployment !== "argos-poc" ||
    labels?.keep !== "true" ||
    labels?.owner !== "matt-demichele"
  ) {
    throw new Error("Missing owned-resource labels: " + address);
  }
}

function validateResourceLabels(type, values, address) {
  if (LABELED_TYPES.has(type)) {
    validateLabels(values?.terraform_labels, address);
  }
  if (type === "google_compute_instance") {
    validateLabels(
      values?.boot_disk?.[0]?.initialize_params?.[0]?.labels,
      address + ".boot_disk",
    );
  }
}

function validateBucket(values, scope, filterEnabled) {
  const name =
    scope === "bootstrap"
      ? "twingate-playground-argos-poc-state"
      : "twingate-playground-argos-poc-screenshots";
  if (
    values.name !== name ||
    values.location?.toUpperCase() !== "US-EAST4" ||
    values.uniform_bucket_level_access !== true ||
    values.public_access_prevention !== "enforced" ||
    values.force_destroy !== false ||
    values.versioning?.[0]?.enabled !== true
  ) {
    throw new Error("Bucket violates the private storage boundary: " + name);
  }
  if (scope === "bootstrap") {
    return;
  }
  const filter = values.ip_filter?.[0];
  const source = filter?.vpc_network_sources?.[0];
  const cors = values.cors?.[0];
  if (
    filterEnabled
      ? values.ip_filter?.length !== 1 ||
        filter?.mode !== "Enabled" ||
        filter.allow_cross_org_vpcs !== false ||
        filter.allow_all_service_agent_access !== false ||
        filter.public_network_source?.length ||
        filter.vpc_network_sources?.length !== 1 ||
        source?.network !==
          "projects/twingate-playground/global/networks/argos-poc-network" ||
        JSON.stringify(source.allowed_ip_cidr_ranges) !==
          JSON.stringify(["10.87.40.10/32"])
      : values.ip_filter?.length
  ) {
    throw new Error("Screenshot bucket exceeds its exact VPC /32 boundary");
  }
  if (
    values.soft_delete_policy?.[0]?.retention_duration_seconds !== 604800 ||
    values.cors?.length !== 1 ||
    JSON.stringify(cors?.origin) !==
      JSON.stringify(["https://app.argos-poc.internal"]) ||
    JSON.stringify(cors?.method) !==
      JSON.stringify(["GET", "HEAD", "POST", "PUT"]) ||
    JSON.stringify(cors?.response_header) !==
      JSON.stringify([
        "Content-Type",
        "Content-Disposition",
        "ETag",
        "Content-Range",
        "Accept-Ranges",
      ]) ||
    cors?.max_age_seconds !== 3600
  ) {
    throw new Error("Screenshot bucket exceeds its CORS or retention boundary");
  }
}

function modules(module) {
  return [
    ...(module?.resources ?? []),
    ...(module?.child_modules ?? []).flatMap(modules),
  ];
}

export function validatePlan(plan, scope) {
  if ((plan.resource_changes ?? []).some((change) => change.change.importing)) {
    throw new Error(
      "Terraform imports are outside this deployment's ownership boundary",
    );
  }
  const changes = (plan.resource_changes ?? []).filter(
    (change) =>
      change.mode !== "data" &&
      !change.change.actions.every((action) => action === "no-op"),
  );
  for (const change of changes) {
    const { actions, after } = change.change;
    const resource = change.address.split("[")[0];
    if (actions.includes("create") && actions.includes("delete")) {
      throw new Error(`Unapproved replacement: ${change.address}`);
    }
    if (actions.includes("delete") && PROTECTED_TYPES.test(change.type)) {
      throw new Error(`Protected resource deletion: ${change.address}`);
    }
    if (scope === "bootstrap") {
      if (
        change.type !== "google_storage_bucket" ||
        (after && after.name !== "twingate-playground-argos-poc-state")
      ) {
        throw new Error(`Unexpected bootstrap change: ${change.address}`);
      }
    } else if (
      !APPROVED_RESOURCES.has(resource) &&
      !(
        RETIRED_RESOURCES.has(resource) &&
        actions.every((action) => action === "delete")
      )
    ) {
      throw new Error("Unexpected main resource address: " + change.address);
    }
    if (change.type === "google_compute_instance" && after) {
      if (
        after.name !== "argos-poc" ||
        !after.machine_type.endsWith("e2-standard-2")
      ) {
        throw new Error("Unexpected VM name or machine type");
      }
      if (
        after.network_interface?.length !== 1 ||
        after.network_interface[0].access_config?.length ||
        after.network_interface[0].network_ip !== "10.87.40.10"
      ) {
        throw new Error("VM network violates private-address boundary");
      }
      if (after.boot_disk?.[0]?.initialize_params?.[0]?.size !== 20) {
        throw new Error("Unexpected VM boot disk size");
      }
      if (
        after.metadata?.["enable-oslogin"] !== "TRUE" ||
        after.metadata?.["block-project-ssh-keys"] !== "TRUE"
      ) {
        throw new Error("Required OS Login/inherited SSH protections missing");
      }
    }
    if (change.type === "google_compute_firewall" && after) {
      if (
        after.direction !== "INGRESS" ||
        JSON.stringify(after.source_ranges) !==
          JSON.stringify(["35.235.240.0/20"]) ||
        after.allow?.length !== 1 ||
        after.allow[0].protocol !== "tcp" ||
        JSON.stringify(after.allow[0].ports) !== JSON.stringify(["22"])
      ) {
        throw new Error("Firewall exceeds IAP-only SSH boundary");
      }
    }
    if (after) {
      validateResourceLabels(change.type, after, change.address);
    }
  }
  const planned = modules(plan.planned_values?.root_module);
  for (const resource of planned) {
    if (resource.mode !== "data") {
      validateResourceLabels(resource.type, resource.values, resource.address);
      if (resource.type === "google_storage_bucket") {
        validateBucket(
          resource.values,
          scope,
          plan.planned_values?.outputs?.storage_ip_filter_enabled?.value,
        );
      }
    }
  }
  const instances = planned.filter(
    (resource) => resource.type === "google_compute_instance",
  );
  if (scope === "main" && instances.length !== 1) {
    throw new Error("Main plan must contain exactly one VM");
  }
  console.log(
    `Validated ${changes.length} owned resource changes; no replacement or public app ingress.`,
  );
  return changes.map(({ address, type, change }) => ({
    address,
    type,
    actions: change.actions,
  }));
}

async function confirmApply(scope, summary) {
  if (!process.stdin.isTTY) {
    throw new Error("Applying a saved plan requires typed confirmation");
  }
  for (const { address, actions } of summary) {
    console.log(`${actions.join("+")} ${address}`);
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      `Type "apply ${scope}" to apply these ${summary.length} changes: `,
    );
    if (answer.trim() !== `apply ${scope}`) {
      throw new Error("Apply not confirmed; the saved plan was not applied");
    }
  } finally {
    prompt.close();
  }
}

if (process.argv[1]?.endsWith("/terraform.mjs")) {
  await entry(async () => {
    const [scope, command, ...args] = process.argv.slice(2);
    if (
      !["bootstrap", "main"].includes(scope) ||
      !["init", "plan", "apply", "output"].includes(command)
    ) {
      throw new Error(
        "Usage: terraform.mjs bootstrap|main init|plan|apply [Terraform arguments]; terraform.mjs main output",
      );
    }
    if (command === "output" && (scope !== "main" || args.length !== 0)) {
      throw new Error(
        "Output export requires main scope and no extra arguments",
      );
    }
    if (
      args.some(
        (arg) =>
          /^(-out|-state|-chdir|-backend-config|-replace|-target|-destroy|-auto-approve)/.test(
            arg,
          ) || arg.endsWith(".tfplan"),
      )
    ) {
      throw new Error(
        "State paths, saved plans, targeted plans and replacements are operator-controlled",
      );
    }
    await privateDir();
    await privateDir(join(STATE, "terraform-data", scope));
    await privateDir(join(STATE, "plans"));
    const directory = join(ROOT, scope === "main" ? "terraform" : "bootstrap");
    const environment = {
      TF_DATA_DIR: join(STATE, "terraform-data", scope),
      TF_INPUT: "0",
    };
    for (const key of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      if (process.env[key] !== undefined) {
        environment[key] = process.env[key];
        delete process.env[key];
      }
    }
    const base = [
      "exec",
      "terraform@1.12.1",
      "--",
      "terraform",
      `-chdir=${directory}`,
    ];
    const terraform = (parameters, options = {}) =>
      run("mise", [...base, ...parameters], {
        env: environment,
        timeout: 900_000,
        ...options,
      });
    const exportOutputs = async () => {
      const outputs = JSON.parse(
        (await terraform(["output", "-json"], { sensitive: true })).stdout,
      );
      await privateWrite(
        join(STATE, "terraform-outputs.json"),
        JSON.stringify(outputs, null, 2) + "\n",
      );
    };
    if (command === "init") {
      if (scope === "bootstrap") {
        await preflight(scope);
      }
      await terraform(
        [
          "init",
          "-input=false",
          ...(scope === "bootstrap"
            ? [`-backend-config=path=${join(STATE, "bootstrap.tfstate")}`]
            : [
                "-backend-config=bucket=twingate-playground-argos-poc-state",
                "-backend-config=prefix=terraform",
              ]),
          ...args,
        ],
        { inherit: true },
      );
      await terraform(
        [
          "providers",
          "lock",
          "-platform=darwin_arm64",
          "-platform=linux_amd64",
        ],
        { inherit: true },
      );
      await terraform(["validate"], { inherit: true });
      return;
    }
    await preflight(scope);
    if (command === "output") {
      await exportOutputs();
      return;
    }
    if (scope === "main") {
      if (command === "apply") {
        await checkProvisioningPermissions();
      }
      const { rootCert } = await ensurePki();
      environment.TF_VAR_ca_certificate_path = rootCert;
      environment.TWINGATE_API_TOKEN = await twingateToken();
    }
    const proxy = environment.HTTPS_PROXY ?? environment.https_proxy;
    const unfilteredBootstrap = args.some(
      (arg, index) =>
        arg === "-var=storage_ip_filter_enabled=false" ||
        (arg === "-var" &&
          args[index + 1] === "storage_ip_filter_enabled=false"),
    );
    if (scope === "main" && !unfilteredBootstrap) {
      if (!proxy || !/^socks5:\/\/127\.0\.0\.1:\d+$/.test(proxy)) {
        throw new Error(
          "Filtered storage operations require HTTPS_PROXY=socks5://127.0.0.1:<operator-IAP-tunnel-port>. Only the initial empty private bootstrap may pass -var=storage_ip_filter_enabled=false.",
        );
      }
    }
    const path = resolve(STATE, "plans", `${scope}.tfplan`);
    const planArgs = ["plan", "-input=false", ...args, `-out=${path}`];
    await terraform(planArgs, { inherit: true });
    await chmod(path, 0o600);
    const plan = JSON.parse(
      (await terraform(["show", "-json", path], { sensitive: true })).stdout,
    );
    const summary = validatePlan(plan, scope);
    if (scope === "main") {
      const enabled =
        plan.planned_values?.outputs?.storage_ip_filter_enabled?.value;
      if (typeof enabled !== "boolean") {
        throw new Error("The plan must declare the storage IP-filter phase");
      }
      if (enabled && (!proxy || !/^socks5:\/\/127\.0\.0\.1:\d+$/.test(proxy))) {
        throw new Error(
          "Enabling the storage filter requires the operator IAP SOCKS tunnel",
        );
      }
      if (!enabled) {
        const current = JSON.parse(
          (await terraform(["output", "-json"], { sensitive: true })).stdout,
        );
        if (current.storage_ip_filter_enabled?.value === true) {
          throw new Error(
            "An enabled storage filter cannot return to the private bootstrap phase",
          );
        }
        console.log(
          "Empty IAM-private bootstrap only: do not create HMAC credentials or start Argos until the filtered full apply completes through the operator tunnel.",
        );
      }
    }
    await privateWrite(
      `${path}.summary.json`,
      JSON.stringify(summary, null, 2) + "\n",
    );
    if (command === "apply") {
      await confirmApply(scope, summary);
      await terraform(["apply", "-input=false", path], { inherit: true });
      if (scope === "bootstrap") {
        await chmod(join(STATE, "bootstrap.tfstate"), 0o600);
      }
      if (scope === "main") {
        await exportOutputs();
      }
    } else {
      console.log(`Protected plan saved at ${path}`);
    }
  });
}
