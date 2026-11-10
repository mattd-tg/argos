import type { IncomingMessage } from "node:http";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type ProtectedHeaderParameters,
  type RemoteJWKSet,
} from "jose";
import { z } from "zod";

import config from "@/config";
import { boom } from "@/util/error";

export interface VerifiedGatewayIdentity {
  tenantHost: string;
  subject: string;
  email: string | null;
  groups: string[];
  /** Unix epoch milliseconds, suitable for scheduling connection expiry. */
  expiresAt: number;
}

const ResourceSchema = z.object({
  type: z.string(),
  address: z.string(),
});

const UserSchema = z.object({
  id: z.string().min(1),
  groups: z.array(z.string()),
  email: z.email().nullable().optional(),
});

interface GatewayConfig {
  tenantHost: string;
  audience: string;
  jwksUrl: URL;
  resourceAddress: string;
  entryGroup: string;
}

let remoteJwks: RemoteJWKSet | null = null;
let remoteJwksUrl: string | null = null;

function unauthorized(): never {
  throw boom(401, "Unauthorized");
}

function forbidden(): never {
  throw boom(403, "Forbidden");
}

function unavailable(): never {
  throw boom(503, "Service Unavailable");
}

/** `createConfig` validates these values at startup. */
function getGatewayConfig(): GatewayConfig {
  return {
    tenantHost: config.get("twingate.gateway.tenantHost").trim(),
    audience: config.get("twingate.gateway.audience").trim(),
    jwksUrl: new URL(config.get("twingate.gateway.jwksUrl").trim()),
    resourceAddress: config.get("twingate.gateway.resourceAddress").trim(),
    entryGroup: config.get("twingate.gateway.entryGroup").trim(),
  };
}

function getRemoteJwks(jwksUrl: URL): RemoteJWKSet {
  if (!remoteJwks || remoteJwksUrl !== jwksUrl.href) {
    remoteJwks = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 5_000,
      cacheMaxAge: 86_400_000,
      cooldownDuration: 60_000,
    });
    remoteJwksUrl = jwksUrl.href;
  }

  return remoteJwks;
}

function getGatewayToken(
  request: Pick<IncomingMessage, "headers" | "rawHeaders">,
): string {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "x-twingate-gat") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }

  if (values.length !== 1) {
    unauthorized();
  }

  const token = values[0]?.trim();
  if (
    !token ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    unauthorized();
  }

  return token;
}

function hasGatewayEntryGroup(groups: string[], entryGroup: string): boolean {
  const expected = entryGroup.toLowerCase();
  if (expected === "everyone" || expected.startsWith("twingate:")) {
    return false;
  }

  return groups.some((group) => group.toLowerCase() === expected);
}

function isJwtValidationError(error: unknown): boolean {
  return (
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWKSNoMatchingKey
  );
}

/**
 * Verifies the assertion injected by Twingate Gateway. It deliberately reads
 * raw headers so duplicate identity headers cannot be collapsed by Node.
 */
export async function verifyGatewayRequest(
  request: Pick<IncomingMessage, "headers" | "rawHeaders">,
): Promise<VerifiedGatewayIdentity> {
  const { tenantHost, audience, jwksUrl, resourceAddress, entryGroup } =
    getGatewayConfig();
  const token = getGatewayToken(request);

  // jose throws a plain TypeError, not a JOSEError, for a dot-shaped token
  // whose header does not decode.
  let header: ProtectedHeaderParameters;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    unauthorized();
  }
  const { alg, kid } = header;
  if (alg !== "ES256" || typeof kid !== "string" || !kid) {
    unauthorized();
  }

  try {
    const { payload } = await jwtVerify(token, getRemoteJwks(jwksUrl), {
      algorithms: ["ES256"],
      audience,
      clockTolerance: 30,
      requiredClaims: ["exp", "iat"],
    });
    const { exp, iat } = payload;

    const now = Date.now() / 1_000;
    if (
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      typeof iat !== "number" ||
      !Number.isFinite(iat) ||
      iat > now + 30
    ) {
      unauthorized();
    }

    const resource = ResourceSchema.safeParse(payload["resource"]);
    if (!resource.success) {
      unauthorized();
    }
    const { type, address } = resource.data;
    if (type !== "WEB_APP" || address !== resourceAddress) {
      unauthorized();
    }

    const user = UserSchema.safeParse(payload["user"]);
    if (!user.success) {
      unauthorized();
    }
    const { id, email, groups } = user.data;

    if (!hasGatewayEntryGroup(groups, entryGroup)) {
      forbidden();
    }

    return {
      tenantHost,
      subject: id,
      email: email ?? null,
      groups,
      expiresAt: exp * 1_000,
    };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    if (isJwtValidationError(error)) {
      unauthorized();
    }
    unavailable();
  }
}
