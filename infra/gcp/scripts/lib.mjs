import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT = "twingate-playground";
export const PROJECT_NUMBER = "417269620845";
const REGION = "us-east4";
export const ZONE = REGION + "-a";
const PRIVATE_IP = "10.87.40.10";
export const TENANT = "https://argospoc.us2.dev.opstg.com";
const API_KEY_REFERENCE = "op://Employee/dvoowk5su2fks5fgfdbs42mece/credential";
export const OPERATOR_EMAIL = "mattd@twingate.com";
export const OPERATOR_SUBJECT = "VXNlcjo0NzE4";
export const STATE = join(homedir(), ".local/state/argos-poc");
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "../..");
process.umask(0o077);

export const quote = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";

export function compose(path) {
  return (
    "docker compose --project-name argos-poc --project-directory " +
    quote(path) +
    " -f " +
    quote(path + "/compose.yaml") +
    " --env-file " +
    quote(path + "/images.env") +
    " --env-file " +
    quote(path + "/release.env") +
    " --env-file /run/argos-poc/runtime.env --env-file /run/argos-poc/connector.env"
  );
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(TF_LOG|TF_CLI_ARGS)/.test(key) ||
      /^(https?_proxy|all_proxy|no_proxy)$/i.test(key) ||
      /^(CLOUDSDK_CORE_LOG_HTTP|CLOUDSDK_LOG_HTTP|GRPC_TRACE|GRPC_VERBOSITY)$/.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    CLOUDSDK_CORE_LOG_HTTP: "false",
    TF_IN_AUTOMATION: "1",
    ...extra,
  };
}

export async function run(
  command,
  args,
  {
    input,
    env = {},
    cwd = REPO,
    inherit = false,
    sensitive = false,
    allowFailure = false,
    timeout = 300_000,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cleanEnv(env),
      stdio: [
        "pipe",
        inherit ? "inherit" : "pipe",
        inherit ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr?.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `${command} failed (${signal ?? code})${sensitive ? "; sensitive output withheld" : `: ${stderr.trim()}`}`,
          ),
        );
      } else {
        resolvePromise({ stdout, stderr, code });
      }
    });
    child.stdin.end(input);
  });
}

export async function privateDir(path = STATE) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

export async function privateWrite(path, content) {
  await privateDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function jsonFile(path) {
  const content = await readFile(path, "utf8");
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid JSON in protected state file");
  }
}

export async function deploymentOutputs() {
  const raw = await jsonFile(join(STATE, "terraform-outputs.json"));
  const outputs = Object.fromEntries(
    Object.entries(raw).map(([key, item]) => [key, item.value]),
  );
  const deployment = outputs.deployment;
  if (
    outputs.project_id !== PROJECT ||
    outputs.zone !== ZONE ||
    outputs.instance_name !== "argos-poc" ||
    outputs.storage_ip_filter_enabled !== true ||
    deployment?.private_ip !== PRIVATE_IP ||
    deployment?.operator_subject !== OPERATOR_SUBJECT ||
    deployment?.bucket_name !== PROJECT + "-argos-poc-screenshots" ||
    !deployment.vm_id ||
    !deployment.network_id ||
    !deployment.storage_service_account ||
    !["runtime", "connector", "tls"].every((key) => outputs.secret_ids?.[key])
  ) {
    throw new Error(
      "Terraform outputs do not describe the owned private Gateway deployment",
    );
  }
  return outputs;
}

export async function verifyStorageBoundary(outputs) {
  const deployment = outputs.deployment;
  const account = (
    await gcloud([
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ])
  ).stdout.trim();
  if (account !== OPERATOR_EMAIL) {
    throw new Error("Unexpected storage operator identity");
  }
  const token = (
    await gcloud(["auth", "print-access-token"], { sensitive: true })
  ).stdout.trim();
  // A short-lived operator token crosses stdin only. The VM identity has no bucket-admin role.
  const script = [
    "import json,sys,urllib.request",
    "token=sys.stdin.read().strip()",
    "url='https://storage.googleapis.com/storage/v1/b/'+" +
      JSON.stringify(deployment.bucket_name),
    "def get(url):",
    "    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'x-goog-user-project':'twingate-playground'})",
    "    with urllib.request.urlopen(request,timeout=30) as response: return json.load(response)",
    "try:",
    "    bucket=get(url)",
    "    policy=get(url+'/iam')",
    "    print(json.dumps({'bucket':bucket,'policy':policy}))",
    "except Exception:",
    "    print('Storage boundary readback failed; details withheld',file=sys.stderr)",
    "    sys.exit(1)",
  ].join("\n");
  const result = JSON.parse(
    (
      await ssh("python3 -c " + quote(script), {
        input: token,
        sensitive: true,
      })
    ).stdout,
  );
  const bucket = result.bucket;
  const filter = bucket.ipFilter;
  const network =
    "projects/" +
    PROJECT +
    "/global/networks/" +
    deployment.network_id.split("/").at(-1);
  const sources = filter?.vpcNetworkSources;
  const grants = result.policy.bindings ?? [];
  const storageMember = "serviceAccount:" + deployment.storage_service_account;
  if (
    bucket.name !== deployment.bucket_name ||
    filter?.mode !== "Enabled" ||
    filter.publicNetworkSource?.allowedIpCidrRanges?.length ||
    filter.allowCrossOrgVpcs !== false ||
    filter.allowAllServiceAgentAccess !== false ||
    sources?.length !== 1 ||
    sources[0].network !== network ||
    JSON.stringify(sources[0].allowedIpCidrRanges) !==
      JSON.stringify([PRIVATE_IP + "/32"]) ||
    bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
    bucket.iamConfiguration?.publicAccessPrevention !== "enforced" ||
    grants.some((binding) =>
      binding.members?.some((member) =>
        [
          "allUsers",
          "allAuthenticatedUsers",
          "serviceAccount:" + deployment.runtime_service_account,
        ].includes(member),
      ),
    ) ||
    !grants.some(
      (binding) =>
        binding.role === "roles/storage.objectUser" &&
        !binding.condition &&
        binding.members?.includes(storageMember),
    ) ||
    grants.some(
      (binding) =>
        binding.role !== "roles/storage.objectUser" &&
        binding.members?.includes(storageMember),
    )
  ) {
    throw new Error(
      "Live storage IAM/IP filter violates the private least-privilege boundary",
    );
  }
}

export async function twingateToken() {
  const token =
    process.env.TWINGATE_API_TOKEN?.trim() ||
    (
      await run("op", ["read", API_KEY_REFERENCE], { sensitive: true })
    ).stdout.trim();
  if (!token) {
    throw new Error("Missing Twingate operator credential");
  }
  return token;
}

export async function tenantQuery(query) {
  const response = await fetch(TENANT + "/api/graphql/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": await twingateToken(),
    },
    body: JSON.stringify({ query }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("Twingate API request failed");
  }
  const result = await response.json();
  if (result.errors || !result.data) {
    throw new Error("Twingate API query failed; details withheld");
  }
  return result.data;
}

export async function tenantNodes(connection, fields) {
  const nodes = [];
  let cursor;
  do {
    const page = (
      await tenantQuery(
        "{ " +
          connection +
          "(first:100" +
          (cursor ? ",after:" + JSON.stringify(cursor) : "") +
          ") { edges { node { " +
          fields +
          " } } pageInfo { hasNextPage endCursor } } }",
      )
    )[connection];
    nodes.push(...page.edges.map(({ node }) => node));
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error("Incomplete Twingate inventory: " + connection);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}
export async function gcloud(args, options) {
  return run("gcloud", [...args, `--project=${PROJECT}`, "--quiet"], options);
}
export async function gcloudJson(args) {
  return JSON.parse((await gcloud([...args, "--format=json"])).stdout);
}
export function envText(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0$]/.test(String(value))) {
          throw new Error("Invalid environment entry");
        }
        return `${key}=${value}`;
      })
      .join("\n") + "\n"
  );
}
export async function ssh(command, options = {}) {
  return gcloud(
    [
      "compute",
      "ssh",
      "argos-poc",
      `--zone=${ZONE}`,
      "--tunnel-through-iap",
      "--command",
      command,
    ],
    { timeout: 900_000, ...options },
  );
}
export async function entry(main) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
