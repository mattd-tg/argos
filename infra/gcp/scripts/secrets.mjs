import {
  createHash,
  createPrivateKey,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { access, chmod, lstat, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  deploymentOutputs,
  entry,
  gcloud,
  jsonFile,
  privateDir,
  privateWrite,
  run,
  STATE,
  TENANT,
  verifyStorageBoundary,
} from "./lib.mjs";

const PKI = join(STATE, "pki");
const DOMAIN = "argos-poc.internal";
const ROOT_NAME_CONSTRAINTS = `permitted;DNS:${DOMAIN},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::`;
const hex = (size = 32) => randomBytes(size).toString("hex");
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensurePki({
  renewLeaves = false,
  retainedOnly = false,
} = {}) {
  await privateDir(PKI);
  const rootKey = join(PKI, "root.key");
  const rootCert = join(PKI, "root.crt");
  const keyExists = await exists(rootKey);
  const certExists = await exists(rootCert);
  if (keyExists !== certExists) {
    throw new Error("Incomplete retained CA; refusing implicit replacement");
  }
  if (!keyExists) {
    if (retainedOnly) {
      throw new Error(
        "TLS staging requires the retained CA; refusing replacement",
      );
    }
    await run(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        rootKey,
      ],
      { sensitive: true },
    );
    await run(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-sha256",
        "-days",
        "365",
        "-key",
        rootKey,
        "-out",
        rootCert,
        "-subj",
        "/CN=Argos PoC Root CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        // People trust this root in their own keychains: even with its key
        // leaked, it must not vouch for any other site or for an IP address.
        "-addext",
        `nameConstraints=critical,${ROOT_NAME_CONSTRAINTS}`,
      ],
      { sensitive: true },
    );
    await chmod(rootKey, 0o600);
  }
  const { stdout: constraints } = await run("openssl", [
    "x509",
    "-in",
    rootCert,
    "-noout",
    "-ext",
    "nameConstraints",
  ]);
  if (!constraints.includes(`DNS:${DOMAIN}`)) {
    throw new Error(`The retained root CA is not limited to ${DOMAIN}`);
  }
  await run(
    "openssl",
    ["x509", "-checkend", "604800", "-noout", "-in", rootCert],
    { sensitive: true },
  );
  for (const [name, hosts] of Object.entries(TLS_HOSTS)) {
    const key = join(PKI, `${name}.key`);
    const cert = join(PKI, `${name}.crt`);
    if ((await exists(key)) !== (await exists(cert))) {
      throw new Error(`Incomplete ${name} certificate pair`);
    }
    const valid =
      (await exists(cert)) &&
      (
        await run(
          "openssl",
          ["x509", "-checkend", "604800", "-noout", "-in", cert],
          { allowFailure: true },
        )
      ).code === 0;
    if (renewLeaves || !valid) {
      const nextKey = `${key}.next`;
      const nextCert = `${cert}.next`;
      const csr = join(PKI, `${name}.csr`);
      const extensions = join(PKI, `${name}.extensions`);
      await privateWrite(
        extensions,
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
      );
      await run(
        "openssl",
        [
          "genpkey",
          "-algorithm",
          "EC",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-out",
          nextKey,
        ],
        { sensitive: true },
      );
      await run(
        "openssl",
        [
          "req",
          "-new",
          "-key",
          nextKey,
          "-out",
          csr,
          "-subj",
          `/CN=${hosts[0]}`,
        ],
        { sensitive: true },
      );
      await run(
        "openssl",
        [
          "x509",
          "-req",
          "-sha256",
          "-days",
          "30",
          "-in",
          csr,
          "-CA",
          rootCert,
          "-CAkey",
          rootKey,
          "-set_serial",
          `0x${hex(16)}`,
          "-extfile",
          extensions,
          "-out",
          nextCert,
        ],
        { sensitive: true },
      );
      const { rename } = await import("node:fs/promises");
      await rename(nextKey, key);
      await rename(nextCert, cert);
      await chmod(key, 0o600);
    }
    await run("openssl", [
      "verify",
      "-CAfile",
      rootCert,
      "-verify_hostname",
      hosts[0],
      cert,
    ]);
  }
  const fingerprint = (
    await run("openssl", [
      "x509",
      "-in",
      rootCert,
      "-noout",
      "-fingerprint",
      "-sha256",
    ])
  ).stdout.trim();
  await privateWrite(join(PKI, "root-fingerprint.txt"), `${fingerprint}\n`);
  return { rootCert, fingerprint };
}

const RUNTIME_PATCH_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "TWINGATE_GATEWAY_ENROLLMENT_ENABLED",
  "TWINGATE_GATEWAY_ENROLLMENT_TEAM_ACCOUNT_ID",
  "TWINGATE_GATEWAY_ENROLLMENT_REVIEWER_PROJECT_IDS",
]);
const canonical = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");

function validateStringMap(value, description) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.entries(value).some(
      ([key, item]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        typeof item !== "string" ||
        /[\r\n\0'\\]/.test(item),
    )
  ) {
    throw new Error(description + " must be a safe environment string map");
  }
  return value;
}

export async function assertPrivateFile(path, description = "Input file") {
  const resolved = resolve(path);
  const inside = relative(STATE, resolved);
  if (!inside || inside.startsWith("..")) {
    throw new Error(description + " must be inside protected state");
  }
  for (let current = resolved; ; current = dirname(current)) {
    const details = await lstat(current);
    if (
      details.isSymbolicLink() ||
      (current === resolved ? !details.isFile() : !details.isDirectory()) ||
      details.mode & 0o077 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())
    ) {
      throw new Error(description + " is not protected");
    }
    if (current === STATE) {
      return resolved;
    }
  }
}

export async function readProtectedJson(path, description = "Input file") {
  return jsonFile(await assertPrivateFile(path, description));
}

export async function readRuntimeVersion(version) {
  if (!/^[1-9][0-9]*$/.test(version)) {
    throw new Error("Invalid runtime secret version");
  }
  const outputs = await deploymentOutputs();
  const result = await gcloud(
    [
      "secrets",
      "versions",
      "access",
      version,
      "--secret=" + outputs.secret_ids.runtime,
    ],
    { sensitive: true },
  );
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Runtime secret is malformed; details withheld");
  }
  return validateStringMap(value, "Runtime secret");
}

export async function addSecret(name, value) {
  const result = await gcloud(
    ["secrets", "versions", "add", name, "--data-file=-", "--format=json"],
    { input: JSON.stringify(value), sensitive: true },
  );
  const version = JSON.parse(result.stdout).name?.split("/").at(-1);
  if (!/^[1-9][0-9]*$/.test(version ?? "")) {
    throw new Error("Secret version response was invalid");
  }
  return version;
}

export async function initializeSecrets(hmacFile) {
  const outputs = await deploymentOutputs();
  await verifyStorageBoundary(outputs);
  const identity = outputs.deployment;
  if (await exists(join(STATE, "release.json"))) {
    throw new Error(
      "Installed deployment: use stage-runtime, never regenerate database credentials",
    );
  }
  const hmac = await readProtectedJson(hmacFile, "HMAC credential");
  if (
    hmac.serviceAccountEmail !== identity.storage_service_account ||
    typeof hmac.accessId !== "string" ||
    !hmac.accessId ||
    typeof hmac.secret !== "string" ||
    !hmac.secret
  ) {
    throw new Error(
      "HMAC credential does not belong to the output storage identity",
    );
  }
  const { rootCert } = await ensurePki();
  const materialPath = join(STATE, "initial-secrets.private.json");
  let material;
  if (await exists(materialPath)) {
    material = await readProtectedJson(materialPath);
    if (
      material.deployment.vm_id !== identity.vm_id ||
      material.runtime.AWS_ACCESS_KEY_ID !== hmac.accessId ||
      material.runtime.AWS_SECRET_ACCESS_KEY !== hmac.secret
    ) {
      throw new Error(
        "Retained initial secret material belongs to a different installation",
      );
    }
  } else {
    const password = hex();
    const rabbitPassword = hex();
    const runtime = validateStringMap(
      {
        NODE_ENV: "production",
        ARGOS_TARGET: "local",
        PORT: "4001",
        DATABASE_URL: "postgres://argos:" + password + "@postgres:5432/argos",
        REDIS_URL: "redis://redis:6379",
        AMQP_URL: "amqp://argos:" + rabbitPassword + "@rabbitmq:5672",
        AMQP_QUEUE_PREFIX: "argos-poc",
        SERVER_URL: "https://app.argos-poc.internal",
        API_BASE_URL: "https://api.argos-poc.internal",
        SESSION_DOMAIN: "",
        WEBAUTHN_RP_ID: "app.argos-poc.internal",
        ASSETS_BASE_URL: "",
        WILDCARD_DOMAINS: "",
        S3_PUBLIC_IMAGE_BASE_URL: "",
        AWS_SCREENSHOTS_BUCKET: identity.bucket_name,
        S3_REGION: "auto",
        AWS_ENDPOINT_URL_S3: "https://storage.googleapis.com",
        S3_FORCE_PATH_STYLE: "false",
        AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_ACCESS_KEY_ID: hmac.accessId,
        AWS_SECRET_ACCESS_KEY: hmac.secret,
        NODE_EXTRA_CA_CERTS: "/run/argos-poc/root.crt",
        TRACK_NPM_PACKAGE_VERSIONS: "false",
        EMAIL_ENABLED: "false",
        POSTGRES_USER: "argos",
        POSTGRES_DB: "argos",
        POSTGRES_PASSWORD: password,
        RABBITMQ_DEFAULT_USER: "argos",
        RABBITMQ_DEFAULT_PASS: rabbitPassword,
        ENCRYPTION_KEY: hex(),
        SERVER_SESSION_SECRET: hex(),
        TWINGATE_GATEWAY_ENABLED: "true",
        TWINGATE_TENANT_HOST: new URL(TENANT).hostname,
        TWINGATE_GATEWAY_AUDIENCE: new URL(TENANT).hostname.split(".")[0],
        TWINGATE_GATEWAY_JWKS_URL: TENANT + "/api/v1/jwk/ec",
        TWINGATE_GATEWAY_RESOURCE_ADDRESS: "app.argos-poc.internal",
        TWINGATE_GATEWAY_ENTRY_GROUP: "argos-poc-admins",
        TWINGATE_GATEWAY_ENROLLMENT_ENABLED: "false",
      },
      "Generated runtime",
    );
    const tokens = outputs.connector_tokens;
    const connector = validateStringMap(
      {
        TWINGATE_ACCESS_TOKEN: tokens?.access_token,
        TWINGATE_REFRESH_TOKEN: tokens?.refresh_token,
      },
      "Connector tokens",
    );
    if (!connector.TWINGATE_ACCESS_TOKEN || !connector.TWINGATE_REFRESH_TOKEN) {
      throw new Error("Missing Connector output");
    }
    const tls = {
      rootCert: await readFile(rootCert, "utf8"),
      proxyCert: await readFile(join(PKI, "proxy.crt"), "utf8"),
      proxyKey: await readFile(join(PKI, "proxy.key"), "utf8"),
      gatewayCert: await readFile(join(PKI, "gateway.crt"), "utf8"),
      gatewayKey: await readFile(join(PKI, "gateway.key"), "utf8"),
    };
    material = { deployment: identity, runtime, connector, tls, versions: {} };
    await privateWrite(materialPath, JSON.stringify(material, null, 2) + "\n");
  }
  for (const [key, pin] of [
    ["runtime", "RUNTIME_SECRET_VERSION"],
    ["connector", "CONNECTOR_SECRET_VERSION"],
    ["tls", "TLS_SECRET_VERSION"],
  ]) {
    if (!material.versions[pin]) {
      material.versions[pin] = await addSecret(
        outputs.secret_ids[key],
        material[key],
      );
      await privateWrite(
        materialPath,
        JSON.stringify(material, null, 2) + "\n",
      );
    }
  }
  await privateWrite(
    join(STATE, "secret-versions.json"),
    JSON.stringify(material.versions, null, 2) + "\n",
  );
  return material.versions;
}

export async function stageRuntime({
  fromVersion,
  patchFile,
  patch: suppliedPatch,
}) {
  const outputs = await deploymentOutputs();
  const patch = validateStringMap(
    suppliedPatch ?? (await readProtectedJson(patchFile, "Runtime patch")),
    "Runtime patch",
  );
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some((key) => !RUNTIME_PATCH_KEYS.has(key))
  ) {
    throw new Error("Unsupported runtime patch");
  }
  const pins = await readProtectedJson(join(STATE, "secret-versions.json"));
  const recordPath = join(STATE, "runtime-candidates.json");
  const records = (await exists(recordPath))
    ? await readProtectedJson(recordPath)
    : [];
  if (
    pins.RUNTIME_SECRET_VERSION !== fromVersion &&
    !records.some(
      (item) =>
        item.version === fromVersion &&
        item.fromVersion === pins.RUNTIME_SECRET_VERSION &&
        item.vmId === outputs.deployment.vm_id,
    )
  ) {
    throw new Error(
      "Runtime source is not the active pin or its owned staged candidate",
    );
  }
  const current = await readRuntimeVersion(fromVersion);
  const next = { ...current, ...patch };
  if (canonical(current) === canonical(next)) {
    return { version: fromVersion, reused: true };
  }
  const patchSha256 = digest(patch);
  const existing = records.find(
    (item) =>
      item.fromVersion === fromVersion &&
      item.patchSha256 === patchSha256 &&
      item.vmId === outputs.deployment.vm_id,
  );
  if (existing) {
    if (
      canonical(await readRuntimeVersion(existing.version)) !== canonical(next)
    ) {
      throw new Error("Staged runtime candidate drift");
    }
    return { version: existing.version, reused: true };
  }
  const version = await addSecret(outputs.secret_ids.runtime, next);
  records.push({
    fromVersion,
    patchSha256,
    version,
    vmId: outputs.deployment.vm_id,
    createdAt: new Date().toISOString(),
  });
  await privateWrite(recordPath, JSON.stringify(records, null, 2) + "\n");
  return { version, reused: false };
}

const TLS_VERSION = /^[1-9][0-9]*$/;
const TLS_CANDIDATES = join(STATE, "tls-candidates.json");
const TLS_FIELDS = [
  "rootCert",
  "proxyCert",
  "proxyKey",
  "gatewayCert",
  "gatewayKey",
];
const TLS_HOSTS = {
  proxy: ["app.argos-poc.internal", "api.argos-poc.internal"],
  gateway: ["gateway.argos-poc.internal", "app.argos-poc.internal"],
};
const TLS_RENEWAL_WINDOW = 604800_000;

function tlsRoot(material) {
  try {
    const root = new X509Certificate(material.rootCert);
    if (
      !root.ca ||
      !root.checkIssued(root) ||
      !root.verify(root.publicKey) ||
      Date.parse(root.validFrom) > Date.now() ||
      Date.parse(root.validTo) <= Date.now() + TLS_RENEWAL_WINDOW
    ) {
      throw new Error();
    }
    return root;
  } catch {
    throw new Error("TLS root is invalid or expires within seven days");
  }
}

function validateTlsMaterial(material, requireFresh = true) {
  const root = tlsRoot(material);
  let expiresAt = Date.parse(root.validTo);
  try {
    for (const [name, hosts] of Object.entries(TLS_HOSTS)) {
      const cert = new X509Certificate(material[name + "Cert"]);
      const key = createPrivateKey(material[name + "Key"]);
      const sans = cert.subjectAltName?.split(", ").sort();
      if (
        cert.ca ||
        !cert.checkPrivateKey(key) ||
        !cert.checkIssued(root) ||
        !cert.verify(root.publicKey) ||
        JSON.stringify(sans) !==
          JSON.stringify(hosts.map((host) => "DNS:" + host).sort()) ||
        hosts.some((host) => cert.checkHost(host) !== host) ||
        !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
        Date.parse(cert.validFrom) > Date.now()
      ) {
        throw new Error();
      }
      expiresAt = Math.min(expiresAt, Date.parse(cert.validTo));
    }
    if (requireFresh && expiresAt <= Date.now() + TLS_RENEWAL_WINDOW) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "TLS leaf certificates, keys, SANs, chain or validity are invalid",
    );
  }
  return { rootFingerprint: root.fingerprint256, expiresAt };
}

async function readTlsVersion(version, outputs) {
  if (!TLS_VERSION.test(version ?? "")) {
    throw new Error("Invalid TLS secret version");
  }
  const result = await gcloud(
    [
      "secrets",
      "versions",
      "access",
      version,
      "--secret=" + outputs.secret_ids.tls,
    ],
    { sensitive: true },
  );
  let material;
  try {
    material = JSON.parse(result.stdout);
    if (
      !material ||
      Array.isArray(material) ||
      typeof material !== "object" ||
      Object.keys(material).length !== TLS_FIELDS.length ||
      TLS_FIELDS.some(
        (field) => typeof material[field] !== "string" || !material[field],
      )
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("TLS secret is malformed; details withheld");
  }
  return material;
}

async function tlsContext() {
  const outputs = await deploymentOutputs();
  const release = await readProtectedJson(join(STATE, "release.json"));
  const pins = await readProtectedJson(join(STATE, "secret-versions.json"));
  if (
    release.vmId !== outputs.deployment.vm_id ||
    !TLS_VERSION.test(pins.TLS_SECRET_VERSION ?? "")
  ) {
    throw new Error(
      "TLS staging requires the owned active Gateway installation",
    );
  }
  const fromVersion = pins.TLS_SECRET_VERSION;
  const active = await readTlsVersion(fromVersion, outputs);
  const root = tlsRoot(active);
  const rootPath = join(PKI, "root.crt");
  const rootDetails = await lstat(rootPath);
  const keyPath = await assertPrivateFile(
    join(PKI, "root.key"),
    "Retained CA key",
  );
  if (
    !rootDetails.isFile() ||
    rootDetails.isSymbolicLink() ||
    (typeof process.getuid === "function" &&
      rootDetails.uid !== process.getuid()) ||
    (await readFile(rootPath, "utf8")) !== active.rootCert
  ) {
    throw new Error(
      "Retained CA does not exactly match the active TLS secret root",
    );
  }
  try {
    if (
      !root.checkPrivateKey(createPrivateKey(await readFile(keyPath, "utf8")))
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Retained CA key does not match the active TLS secret root",
    );
  }
  return {
    outputs,
    active,
    fromVersion,
    vmId: outputs.deployment.vm_id,
    rootFingerprint: root.fingerprint256,
  };
}

async function tlsRecords() {
  const records = (await exists(TLS_CANDIDATES))
    ? await readProtectedJson(TLS_CANDIDATES)
    : [];
  if (
    !Array.isArray(records) ||
    records.some(
      (record) =>
        !record ||
        !TLS_VERSION.test(record.version ?? "") ||
        !TLS_VERSION.test(record.fromVersion ?? "") ||
        record.version === record.fromVersion ||
        typeof record.vmId !== "string" ||
        typeof record.rootFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.tlsSha256 ?? "") ||
        typeof record.renewed !== "boolean",
    )
  ) {
    throw new Error("TLS candidate records are malformed");
  }
  return records;
}

function tlsMetadata(record) {
  const { version, fromVersion, vmId, rootFingerprint } = record;
  return { version, fromVersion, vmId, rootFingerprint };
}

async function candidateMaterial(record, context, requireFresh = true) {
  if (
    record.fromVersion !== context.fromVersion ||
    record.vmId !== context.vmId ||
    record.rootFingerprint !== context.rootFingerprint
  ) {
    throw new Error("TLS candidate ownership or retained root drift");
  }
  const material = await readTlsVersion(record.version, context.outputs);
  if (
    material.rootCert !== context.active.rootCert ||
    digest(material) !== record.tlsSha256
  ) {
    throw new Error("TLS candidate material drift");
  }
  return validateTlsMaterial(material, requireFresh);
}

export async function readTlsCandidate(version, fromVersion) {
  if (
    !TLS_VERSION.test(version ?? "") ||
    !TLS_VERSION.test(fromVersion ?? "") ||
    version === fromVersion
  ) {
    throw new Error("Invalid TLS candidate versions");
  }
  const context = await tlsContext();
  if (context.fromVersion !== fromVersion) {
    throw new Error("TLS candidate source is not the active secret pin");
  }
  const record = (await tlsRecords()).find(
    (item) => item.version === version && item.fromVersion === fromVersion,
  );
  if (!record) {
    throw new Error("TLS version is not an owned staged candidate");
  }
  await candidateMaterial(record, context);
  return tlsMetadata(record);
}

async function stageTls({ renewLeaves = false } = {}) {
  const context = await tlsContext();
  const records = await tlsRecords();
  if (renewLeaves) {
    for (const record of records.toReversed()) {
      if (
        record.fromVersion === context.fromVersion &&
        record.vmId === context.vmId &&
        record.rootFingerprint === context.rootFingerprint &&
        record.renewed
      ) {
        const { expiresAt } = await candidateMaterial(record, context, false);
        if (expiresAt > Date.now() + TLS_RENEWAL_WINDOW) {
          return tlsMetadata(record);
        }
      }
    }
  }
  await ensurePki({ renewLeaves, retainedOnly: true });
  const material = { rootCert: await readFile(join(PKI, "root.crt"), "utf8") };
  for (const name of Object.keys(TLS_HOSTS)) {
    material[name + "Cert"] = await readFile(join(PKI, name + ".crt"), "utf8");
    material[name + "Key"] = await readFile(
      await assertPrivateFile(join(PKI, name + ".key"), "TLS leaf key"),
      "utf8",
    );
  }
  if (material.rootCert !== context.active.rootCert) {
    throw new Error(
      "Retained CA changed while staging TLS; refusing publication",
    );
  }
  validateTlsMaterial(material);
  const tlsSha256 = digest(material);
  const existing = records.find(
    (record) =>
      record.fromVersion === context.fromVersion &&
      record.vmId === context.vmId &&
      record.rootFingerprint === context.rootFingerprint &&
      record.tlsSha256 === tlsSha256,
  );
  if (existing) {
    await candidateMaterial(existing, context);
    return tlsMetadata(existing);
  }
  const version = await addSecret(context.outputs.secret_ids.tls, material);
  const record = {
    version,
    fromVersion: context.fromVersion,
    vmId: context.vmId,
    rootFingerprint: context.rootFingerprint,
    tlsSha256,
    renewed: renewLeaves,
  };
  records.push(record);
  await privateWrite(TLS_CANDIDATES, JSON.stringify(records, null, 2) + "\n");
  return tlsMetadata(record);
}

if (process.argv[1]?.endsWith("/secrets.mjs")) {
  await entry(async () => {
    const args = process.argv.slice(2);
    if (
      args.length === 3 &&
      args[0] === "initialize" &&
      args[1] === "--hmac-file"
    ) {
      console.log(JSON.stringify(await initializeSecrets(args[2])));
    } else if (
      args.length === 5 &&
      args[0] === "stage-runtime" &&
      args[1] === "--from-version" &&
      args[3] === "--patch-file"
    ) {
      console.log(
        JSON.stringify(
          await stageRuntime({ fromVersion: args[2], patchFile: args[4] }),
        ),
      );
    } else if (
      args[0] === "stage-tls" &&
      (args.length === 1 || (args.length === 2 && args[1] === "--renew"))
    ) {
      console.log(
        JSON.stringify(await stageTls({ renewLeaves: args.length === 2 })),
      );
    } else {
      throw new Error(
        "Usage: secrets.mjs initialize --hmac-file <protected-json> | stage-runtime --from-version <N> --patch-file <protected-json> | stage-tls [--renew]",
      );
    }
  });
}
