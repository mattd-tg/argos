#!/usr/bin/env node
import { parseArgs } from "node:util";

import config from "@/config";
import { knex } from "@/database/knex";
import { provisionGatewayIdentity } from "@/database/services/twingate-gateway";
import logger from "@/logger";

logger.level = "silent";

interface Arguments {
  subject: string;
  userId: string;
}

function parseArguments(args: string[]): Arguments {
  const { values } = parseArgs({
    args,
    options: { subject: { type: "string" }, "user-id": { type: "string" } },
  });
  const { subject, "user-id": userId } = values;
  if (!subject || !userId) {
    throw new Error(
      "Usage: provision-identity --subject <subject> --user-id <user-id>",
    );
  }
  return { subject, userId };
}

async function main() {
  const { subject, userId } = parseArguments(process.argv.slice(2));
  const tenantHost = config.get("twingate.gateway.tenantHost").trim();
  if (!tenantHost) {
    throw new Error("TWINGATE_TENANT_HOST must be configured.");
  }

  const identity = await provisionGatewayIdentity({
    tenantHost,
    twingateUserId: subject,
    userId,
  });

  process.stdout.write(
    `${JSON.stringify({
      id: identity.id,
      tenantHost: identity.tenantHost,
      subject: identity.twingateUserId,
      userId: identity.userId,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Twingate identity provisioning failed."}\n`,
  );
  process.exitCode = 1;
} finally {
  await knex.destroy();
}
