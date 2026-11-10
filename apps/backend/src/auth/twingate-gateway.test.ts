import type { IncomingMessage } from "node:http";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JWK,
  type JWTPayload,
} from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import config from "@/config";

import { assertNativeLoginAllowed } from "./native-login";
import { verifyGatewayRequest } from "./twingate-gateway";

const TENANT_HOST = "gateway.example.test";
const AUDIENCE = "argospoc";
const RESOURCE_ADDRESS = "app.argos-poc.internal";
const ENTRY_GROUP = "argos-poc-admins";

const originalGatewayConfig = {
  enabled: config.get("twingate.gateway.enabled"),
  tenantHost: config.get("twingate.gateway.tenantHost"),
  audience: config.get("twingate.gateway.audience"),
  jwksUrl: config.get("twingate.gateway.jwksUrl"),
  resourceAddress: config.get("twingate.gateway.resourceAddress"),
  entryGroup: config.get("twingate.gateway.entryGroup"),
};

let signingKey: CryptoKey;
let signingJwk: JWK;
let rotatedSigningKey: CryptoKey;
let rotatedSigningJwk: JWK;
let unavailable = false;
let jwksRequests = 0;
let jwks: JWK[] = [];

const jwksServer = setupServer(
  http.get(`https://${TENANT_HOST}/*`, () => {
    jwksRequests += 1;
    if (unavailable) {
      return HttpResponse.error();
    }
    return HttpResponse.json({ keys: jwks });
  }),
);

function configureGateway(path: string) {
  config.set("twingate.gateway.enabled", true);
  config.set("twingate.gateway.tenantHost", TENANT_HOST);
  config.set("twingate.gateway.audience", AUDIENCE);
  config.set("twingate.gateway.jwksUrl", `https://${TENANT_HOST}/${path}`);
  config.set("twingate.gateway.resourceAddress", RESOURCE_ADDRESS);
  config.set("twingate.gateway.entryGroup", ENTRY_GROUP);
}

function request(
  token: string | null,
  duplicateToken?: string,
): Pick<IncomingMessage, "headers" | "rawHeaders"> {
  const rawHeaders = token ? ["X-Twingate-GAT", token] : [];
  if (duplicateToken) {
    rawHeaders.push("x-twingate-gat", duplicateToken);
  }

  return {
    headers: token ? { "x-twingate-gat": token } : {},
    rawHeaders,
  };
}

interface SignGatewayTokenProps {
  signingKey?: CryptoKey;
  kid?: string;
  typ?: string;
  issuer?: string;
  payload?: JWTPayload;
  audience?: string;
  issuedAt?: number;
  expiresAt?: number;
}

async function signGatewayToken(
  props: SignGatewayTokenProps = {},
): Promise<string> {
  const {
    signingKey: key = signingKey,
    kid = "primary",
    typ,
    issuer,
    payload: overrides,
    audience = AUDIENCE,
    issuedAt,
    expiresAt,
  } = props;
  const now = Math.floor(Date.now() / 1_000);
  const payload: JWTPayload = {
    resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
    user: {
      id: "twingate-user-4703",
      email: "mattd@twingate.com",
      groups: [ENTRY_GROUP],
    },
    ...overrides,
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      kid,
      ...(typ ? { typ } : {}),
    })
    .setAudience(audience);
  if (issuer) {
    jwt.setIssuer(issuer);
  }

  jwt.setIssuedAt(issuedAt ?? now);
  jwt.setExpirationTime(expiresAt ?? now + 300);

  return jwt.sign(key);
}

beforeAll(async () => {
  const { privateKey: primaryKey, publicKey: primaryPublicKey } =
    await generateKeyPair("ES256");
  signingKey = primaryKey;
  signingJwk = {
    ...(await exportJWK(primaryPublicKey)),
    alg: "ES256",
    kid: "primary",
    use: "sig",
  };

  const { privateKey: rotatedKey, publicKey: rotatedPublicKey } =
    await generateKeyPair("ES256");
  rotatedSigningKey = rotatedKey;
  rotatedSigningJwk = {
    ...(await exportJWK(rotatedPublicKey)),
    alg: "ES256",
    kid: "rotated",
    use: "sig",
  };

  jwksServer.listen({ onUnhandledFrame: "error" });
});

beforeEach(() => {
  unavailable = false;
  jwksRequests = 0;
  jwks = [signingJwk];
});

afterEach(() => {
  jwksServer.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => {
  jwksServer.close();
  const {
    enabled,
    tenantHost,
    audience,
    jwksUrl,
    resourceAddress,
    entryGroup,
  } = originalGatewayConfig;
  config.set("twingate.gateway.enabled", enabled);
  config.set("twingate.gateway.tenantHost", tenantHost);
  config.set("twingate.gateway.audience", audience);
  config.set("twingate.gateway.jwksUrl", jwksUrl);
  config.set("twingate.gateway.resourceAddress", resourceAddress);
  config.set("twingate.gateway.entryGroup", entryGroup);
});

describe("verifyGatewayRequest", () => {
  test("verifies a signed ES256 assertion and returns its explicit identity", async () => {
    configureGateway("valid");

    await expect(
      verifyGatewayRequest(
        request(
          await signGatewayToken({
            typ: "gateway-assertion",
            issuer: "https://another-issuer.example.test",
          }),
        ),
      ),
    ).resolves.toEqual({
      tenantHost: TENANT_HOST,
      subject: "twingate-user-4703",
      email: "mattd@twingate.com",
      groups: [ENTRY_GROUP],
      expiresAt: expect.any(Number),
    });
  });

  test("allows optional email but never substitutes another identifier", async () => {
    configureGateway("optional-email");
    const token = await signGatewayToken({
      payload: {
        resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
        user: { id: "opaque-id", groups: [ENTRY_GROUP] },
      },
    });

    await expect(verifyGatewayRequest(request(token))).resolves.toMatchObject({
      subject: "opaque-id",
      email: null,
    });
  });

  test("matches only a non-built-in entry group without regard to casing", async () => {
    configureGateway("group");
    const token = await signGatewayToken({
      payload: {
        resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
        user: { id: "opaque-id", groups: ["Argos-Poc-Admins", "Everyone"] },
      },
    });

    await expect(verifyGatewayRequest(request(token))).resolves.toMatchObject({
      subject: "opaque-id",
    });

    config.set("twingate.gateway.entryGroup", "Everyone");
    await expect(verifyGatewayRequest(request(token))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test.each([
    ["missing", request(null)],
    ["duplicate", request("a.b.c", "d.e.f")],
    ["malformed", request("not-a-jwt")],
    ["undecodable", request("a.b.c")],
  ])("rejects a %s identity header", async (_name, gatewayRequest) => {
    configureGateway(`header-${_name}`);
    await expect(verifyGatewayRequest(gatewayRequest)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  test("rejects unsigned, non-ES256, and incomplete JWT assertions", async () => {
    configureGateway("algorithms");
    const payload: JWTPayload = {
      resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
      user: { id: "opaque-id", groups: [ENTRY_GROUP] },
    };
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "primary" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
    const secret = await generateSecret("HS256");
    const hmac = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", kid: "primary" })
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    const missingKid = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256" })
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const missingExpiration = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "primary" })
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .sign(signingKey);
    const missingIssuedAt = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "primary" })
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(signingKey);

    for (const token of [
      none,
      hmac,
      missingKid,
      missingExpiration,
      missingIssuedAt,
    ]) {
      await expect(verifyGatewayRequest(request(token))).rejects.toMatchObject({
        statusCode: 401,
      });
    }
  });

  test("rejects unsupported critical JWT headers as unauthorized", async () => {
    configureGateway("unsupported-critical-header");
    const parts = (await signGatewayToken()).split(".");
    parts[0] = Buffer.from(
      JSON.stringify({
        alg: "ES256",
        kid: "primary",
        crit: ["unsupported"],
        unsupported: true,
      }),
    ).toString("base64url");
    await expect(
      verifyGatewayRequest(request(parts.join("."))),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("rejects signature, audience, scope, time, and identity claim violations", async () => {
    configureGateway("claims");
    const otherKey = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1_000);
    const invalidTokens = [
      await signGatewayToken({ signingKey: otherKey.privateKey }),
      await signGatewayToken({ audience: "another-audience" }),
      await signGatewayToken({
        payload: {
          resource: { type: "TCP", address: RESOURCE_ADDRESS },
          user: { id: "opaque-id", groups: [ENTRY_GROUP] },
        },
      }),
      await signGatewayToken({
        payload: {
          resource: { type: "WEB_APP", address: "other.argos-poc.internal" },
          user: { id: "opaque-id", groups: [ENTRY_GROUP] },
        },
      }),
      await signGatewayToken({ expiresAt: now - 31 }),
      await signGatewayToken({ issuedAt: now + 31 }),
      await signGatewayToken({
        payload: {
          resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
          user: { id: "", groups: [ENTRY_GROUP] },
        },
      }),
      await signGatewayToken({
        payload: {
          resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
          user: {
            id: "opaque-id",
            email: "not-an-email",
            groups: [ENTRY_GROUP],
          },
        },
      }),
    ];

    for (const token of invalidTokens) {
      await expect(verifyGatewayRequest(request(token))).rejects.toMatchObject({
        statusCode: 401,
      });
    }

    const tokenWithoutEntryGroup = await signGatewayToken({
      payload: {
        resource: { type: "WEB_APP", address: RESOURCE_ADDRESS },
        user: { id: "opaque-id", groups: ["twingate:members"] },
      },
    });
    await expect(
      verifyGatewayRequest(request(tokenWithoutEntryGroup)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("refreshes for a rotated key after cooldown and keeps cached keys usable during an outage", async () => {
    configureGateway("rotation");
    const primaryToken = await signGatewayToken();
    await expect(
      verifyGatewayRequest(request(primaryToken)),
    ).resolves.toBeDefined();

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    jwks = [rotatedSigningJwk];
    const rotatedToken = await signGatewayToken({
      signingKey: rotatedSigningKey,
      kid: "rotated",
    });
    await expect(
      verifyGatewayRequest(request(rotatedToken)),
    ).resolves.toBeDefined();

    unavailable = true;
    await expect(
      verifyGatewayRequest(request(rotatedToken)),
    ).resolves.toBeDefined();
  });

  test("throttles unknown-kid JWKS refreshes and treats an unavailable uncached JWKS as service failure", async () => {
    configureGateway("unknown-kid");
    const unknownToken = await signGatewayToken({ kid: "unknown" });

    await expect(
      verifyGatewayRequest(request(unknownToken)),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      verifyGatewayRequest(request(unknownToken)),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(jwksRequests).toBe(1);

    configureGateway("unavailable");
    unavailable = true;
    await expect(
      verifyGatewayRequest(request(await signGatewayToken())),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("assertNativeLoginAllowed", () => {
  test("permits native flows only while Gateway is disabled", () => {
    config.set("twingate.gateway.enabled", false);
    expect(assertNativeLoginAllowed).not.toThrow();

    config.set("twingate.gateway.enabled", true);
    let error: unknown;
    try {
      assertNativeLoginAllowed();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      statusCode: 403,
      code: "GATEWAY_MANAGED_AUTH",
    });
  });
});
