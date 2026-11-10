#!/usr/bin/env node
import { parseArgs } from "node:util";

import config from "@/config";
import { knex } from "@/database/knex";
import logger from "@/logger";
import { bootstrapSelfHost } from "@/self-host/bootstrap";
import { closeRedis } from "@/util/redis/client";

// Stdout is the machine-readable operator protocol.
logger.level = "silent";

const APP_ORIGIN = "https://app.argos-poc.internal";

function assertOperatorEnvironment(): void {
  if (config.get("server.url") !== APP_ORIGIN) {
    throw new Error(
      "self-host operator requires SERVER_URL=https://app.argos-poc.internal",
    );
  }
  if (config.get("pg.connection.database") !== "argos") {
    throw new Error("self-host operator requires database argos");
  }
}

const USAGE =
  "usage: bootstrap.ts bootstrap --email <operator email> --name <display name>";

function parseBootstrapInput(args: string[]): { email: string; name: string } {
  const { values, positionals } = parseArgs({
    args,
    options: { email: { type: "string" }, name: { type: "string" } },
    allowPositionals: true,
  });
  const { email, name } = values;
  if (
    positionals.length !== 1 ||
    positionals[0] !== "bootstrap" ||
    !email ||
    !name
  ) {
    throw new Error(USAGE);
  }
  return { email, name };
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "self-host operator command failed";
}

async function main(): Promise<void> {
  assertOperatorEnvironment();
  const input = parseBootstrapInput(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await bootstrapSelfHost(input))}\n`);
}

let commandFailed = false;
try {
  await main();
} catch (error) {
  commandFailed = true;
  process.stderr.write(`${errorReason(error)}\n`);
  process.exitCode = 1;
}

try {
  await closeRedis();
  await knex.destroy();
} catch (error) {
  if (!commandFailed) {
    process.stderr.write(`${errorReason(error)}\n`);
  }
  process.exitCode = 1;
}
