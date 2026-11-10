import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from ".";

const gatewayEnvironment = {
  NODE_ENV: "development",
  ARGOS_TARGET: "local",
  TWINGATE_GATEWAY_ENABLED: "true",
  TWINGATE_TENANT_HOST: "gateway.example.internal",
  TWINGATE_GATEWAY_AUDIENCE: "argos",
  TWINGATE_GATEWAY_JWKS_URL: "https://gateway.example.internal/api/v1/jwk/ec",
  TWINGATE_GATEWAY_RESOURCE_ADDRESS: "app.example.internal",
  TWINGATE_GATEWAY_ENTRY_GROUP: "argos-users",
  TWINGATE_GATEWAY_ENROLLMENT_ENABLED: "true",
  TWINGATE_GATEWAY_ENROLLMENT_TEAM_ACCOUNT_ID: "3",
  TWINGATE_GATEWAY_ENROLLMENT_REVIEWER_PROJECT_IDS: "1,2",
} satisfies Record<string, string>;

function createGatewayConfig(
  overrides: Partial<Record<keyof typeof gatewayEnvironment, string>> = {},
) {
  for (const [name, value] of Object.entries({
    ...gatewayEnvironment,
    ...overrides,
  })) {
    vi.stubEnv(name, value);
  }
  return createConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Gateway enrollment configuration", () => {
  it("accepts canonical target IDs when Gateway is enabled", () => {
    const config = createGatewayConfig();

    expect(config.get("twingate.gateway.enrollment.enabled")).toBe(true);
    expect(config.get("twingate.gateway.enrollment.teamAccountId")).toBe("3");
    expect(
      config.get("twingate.gateway.enrollment.reviewerProjectIds"),
    ).toEqual(["1", "2"]);
  });

  it("requires Gateway when enrollment is enabled", () => {
    expect(() =>
      createGatewayConfig({ TWINGATE_GATEWAY_ENABLED: "false" }),
    ).toThrow(/ENROLLMENT_ENABLED requires TWINGATE_GATEWAY_ENABLED/);
  });

  it.each(["", "0", "01", "-1", "1.5", "9223372036854775808"])(
    "rejects noncanonical team account ID %j",
    (teamAccountId) => {
      expect(() =>
        createGatewayConfig({
          TWINGATE_GATEWAY_ENROLLMENT_TEAM_ACCOUNT_ID: teamAccountId,
        }),
      ).toThrow(/ENROLLMENT_TEAM_ACCOUNT_ID/);
    },
  );

  it.each(["", "1,1", "0", "01", "1, 2", "9223372036854775808"])(
    "rejects reviewer project IDs %j",
    (reviewerProjectIds) => {
      expect(() =>
        createGatewayConfig({
          TWINGATE_GATEWAY_ENROLLMENT_REVIEWER_PROJECT_IDS: reviewerProjectIds,
        }),
      ).toThrow(/ENROLLMENT_REVIEWER_PROJECT_IDS/);
    },
  );
});
