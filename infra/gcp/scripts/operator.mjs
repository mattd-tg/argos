import { compose, quote, ssh } from "./lib.mjs";

async function runOperatorCommand(path, bin, parameters) {
  const response = await ssh(
    `sudo ${compose(path)} --profile operator run --rm --no-deps -T bootstrap node ${quote(bin)} ${parameters.map(quote).join(" ")}`,
    { sensitive: true },
  );
  try {
    return JSON.parse(response.stdout);
  } catch {
    throw new Error(
      "Operator CLI did not return pure JSON; sensitive output withheld",
    );
  }
}

export async function bootstrap(path, { email, name }) {
  const result = await runOperatorCommand(
    path,
    "apps/backend/dist/self-host/bin/bootstrap.js",
    ["bootstrap", "--email", email, "--name", name],
  );
  if (
    !result ||
    typeof result !== "object" ||
    !["userId", "teamAccountId", "projectId"].every((key) =>
      /^[0-9]+$/.test(result[key]),
    )
  ) {
    throw new Error("Bootstrap returned an invalid identity graph");
  }
  console.log(
    `Bootstrap user=${result.userId}, team=${result.teamAccountId}, project=${result.projectId}`,
  );
  return result;
}

export async function provisionIdentity(path, { subject, userId }) {
  const result = await runOperatorCommand(
    path,
    "apps/backend/dist/self-host/bin/provision-identity.js",
    ["--subject", subject, "--user-id", userId],
  );
  if (
    !result ||
    typeof result !== "object" ||
    !/^[0-9]+$/.test(result.userId)
  ) {
    throw new Error("Identity provisioning returned an invalid mapping");
  }
  console.log(
    `Provisioned explicit Gateway mapping for Argos user ${result.userId}.`,
  );
  return result;
}
