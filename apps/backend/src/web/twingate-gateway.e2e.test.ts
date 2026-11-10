import { createHash, randomBytes } from "node:crypto";
import { on, once } from "node:events";
import { createServer, request as nodeRequest } from "node:http";
import type { Express } from "express";
import { createClient } from "graphql-ws";
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from "jose";
import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test as base,
} from "vitest";
import { WebSocket } from "ws";

import { publishUserPresenceChanged } from "@/auth/presenceEvents";
import { createSession, resolveSession, revokeSession } from "@/auth/session";
import {
  LOGGED_IN_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "@/auth/session-cookie";
import config, { createConfig } from "@/config";
import { knex } from "@/database/knex";
import {
  Account,
  BuildReview,
  NotificationMessage,
  NotificationWorkflow,
  OAuthGrant,
  Project,
  ProjectUser,
  TeamSamlConfig,
  TeamUser,
  TwingateGatewayIdentity,
  User,
  UserEmail,
  UserSession,
} from "@/database/models";
import {
  getGatewayMappedUser,
  provisionGatewayIdentity,
} from "@/database/services/twingate-gateway";
import { factory, setupDatabase } from "@/database/testing";
import { deleteAccount } from "@/graphql/services/account";
import { createGraphQLWebSocketServer } from "@/graphql/ws";
import logger from "@/logger";
import { notificationMessageJob } from "@/notification/message-job";
import { createAuthorizationCode } from "@/oauth/authorization-code";
import { createDynamicClient } from "@/oauth/clients";
import { getRedisClient } from "@/util/redis/client";
import { setupRedis } from "@/util/redis/testing";

import { createApp } from "./app";

const originalServerUrl = config.get("server.url");
const originalWildcardDomains = config.get("server.wildcardDomains");
const originalEmailEnabled = config.get("email.enabled");
const originalGatewayConfig = {
  enabled: config.get("twingate.gateway.enabled"),
  tenantHost: config.get("twingate.gateway.tenantHost"),
  audience: config.get("twingate.gateway.audience"),
  jwksUrl: config.get("twingate.gateway.jwksUrl"),
  resourceAddress: config.get("twingate.gateway.resourceAddress"),
  entryGroup: config.get("twingate.gateway.entryGroup"),
  enrollmentEnabled: config.get("twingate.gateway.enrollment.enabled"),
  enrollmentTeamAccountId: config.get(
    "twingate.gateway.enrollment.teamAccountId",
  ),
  enrollmentReviewerProjectIds: config.get(
    "twingate.gateway.enrollment.reviewerProjectIds",
  ),
};

const tenantHost = "gateway.test";
const audience = "argos-poc";
const resourceAddress = "app.argos-poc.internal";
const entryGroup = "argos-poc-admins";
const jwksUrl = `https://${tenantHost}/api/v1/jwk/ec`;

let privateKey: CryptoKey;
let jwks: Record<string, unknown>[] = [];
let app: Express;
const poolConfig = knex.client.config.pool;
if (!poolConfig) {
  throw new Error("Expected Knex pool configuration");
}
const originalPoolMax = poolConfig.max;

const jwksServer = setupServer(
  http.get(jwksUrl, () => HttpResponse.json({ keys: jwks })),
  http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()),
);

setupRedis();

interface Viewer {
  user: User;
  account: Account;
  subject: string;
}

const test = base.extend<{ viewer: Viewer }>({
  viewer: async ({}, use) => {
    await setupDatabase();
    const user = await factory.User.create({
      email: "gateway-user@example.test",
    });
    const account = await factory.UserAccount.create({ userId: user.id });
    const subject = `twingate-user-${user.id}`;
    await provisionGatewayIdentity({
      tenantHost,
      twingateUserId: subject,
      userId: user.id,
    });
    await use({ user, account, subject });
  },
});

function documentRequest(path: string, token: string) {
  return appRequest(path)
    .set(gatHeader(token))
    .set("Sec-Fetch-Mode", "navigate")
    .set("Sec-Fetch-Dest", "document")
    .set("Accept", "text/html");
}

async function enableEnrollment(): Promise<{
  teamAccount: Account;
  project: Project;
}> {
  const plan = await factory.Plan.create();
  const teamAccount = await factory.TeamAccount.create({
    forcedPlanId: plan.id,
  });
  if (!teamAccount.teamId) {
    throw new Error("Expected a team account");
  }
  const project = await factory.Project.create({ accountId: teamAccount.id });

  config.set("twingate.gateway.enrollment.enabled", true);
  config.set("twingate.gateway.enrollment.teamAccountId", teamAccount.id);
  config.set("twingate.gateway.enrollment.reviewerProjectIds", [project.id]);

  return { teamAccount, project };
}

function appRequest(path: string) {
  return request(app)
    .get(path)
    .set("Host", resourceAddress)
    .set("X-Forwarded-Proto", "https");
}

function gatHeader(token: string) {
  return { "X-Twingate-GAT": token };
}

function sessionCookie(token: string) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

interface GraphqlRequestProps {
  token: string;
  session: string;
  query: string;
  variables?: Record<string, unknown>;
}

function graphqlRequest(props: GraphqlRequestProps) {
  const { token, session, query, variables = {} } = props;
  return request(app)
    .post("/graphql")
    .set("Host", resourceAddress)
    .set("X-Forwarded-Proto", "https")
    .set(gatHeader(token))
    .set("X-Argos-CSRF", "test-csrf")
    .set("Cookie", sessionCookie(session))
    .send({ query, variables });
}

async function rawDocumentRequest(
  path: string,
  token: string,
): Promise<number> {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway test server did not expose a TCP port");
  }

  try {
    const result = Promise.withResolvers<number>();
    const request = nodeRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
        method: "GET",
        headers: {
          Host: resourceAddress,
          "X-Forwarded-Proto": "https",
          "X-Twingate-GAT": token,
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          Accept: "text/html",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => result.resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", result.reject);
    request.end();
    return await result.promise;
  } finally {
    server.close();
    await once(server, "close");
  }
}

function setCookies(response: request.Response): string[] {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function rawCookie(setCookie: string, name: string): string {
  const match = new RegExp("^" + name + "=([^;]*)").exec(setCookie);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error("Missing " + name + " cookie");
  }
  return decodeURIComponent(value);
}

interface SignGatewayTokenProps {
  subject: string;
  email?: string;
  groups?: string[];
  expiresInSeconds?: number;
  resourceAddress?: string;
}

async function signGatewayToken(props: SignGatewayTokenProps): Promise<string> {
  const {
    subject,
    email,
    groups = [entryGroup],
    expiresInSeconds = 60,
    resourceAddress: address = resourceAddress,
  } = props;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    resource: { type: "WEB_APP", address },
    user: {
      id: subject,
      groups,
      ...(email === undefined ? {} : { email }),
    },
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "gateway-test-key" })
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);
}

beforeAll(async () => {
  // The test default is one connection, which would serialize identity claims.
  poolConfig.max = 4;
  await knex.destroy();
  knex.client.initializePool();
  const { privateKey: signingKey, publicKey } = await generateKeyPair("ES256");
  privateKey = signingKey;
  jwks = [
    {
      ...(await exportJWK(publicKey)),
      alg: "ES256",
      kid: "gateway-test-key",
      use: "sig",
    },
  ];
  jwksServer.listen({ onUnhandledFrame: "error" });
  const previousDomainsEnvironment = process.env["WILDCARD_DOMAINS"];
  try {
    process.env["WILDCARD_DOMAINS"] = "";
    config.set(
      "server.wildcardDomains",
      createConfig().get("server.wildcardDomains"),
    );
  } finally {
    if (previousDomainsEnvironment === undefined) {
      delete process.env["WILDCARD_DOMAINS"];
    } else {
      process.env["WILDCARD_DOMAINS"] = previousDomainsEnvironment;
    }
  }

  config.set("twingate.gateway.enabled", true);
  config.set("twingate.gateway.tenantHost", tenantHost);
  config.set("twingate.gateway.audience", audience);
  config.set("twingate.gateway.jwksUrl", jwksUrl);
  config.set("twingate.gateway.resourceAddress", resourceAddress);
  config.set("twingate.gateway.entryGroup", entryGroup);
  config.set("server.url", `https://${resourceAddress}`);

  app = await createApp();
});

afterEach(() => {
  jwksServer.resetHandlers();
  config.set("twingate.gateway.enrollment.enabled", false);
  config.set("twingate.gateway.enrollment.teamAccountId", "");
  config.set("twingate.gateway.enrollment.reviewerProjectIds", []);
});

afterAll(async () => {
  jwksServer.close();
  const {
    enabled,
    tenantHost: originalTenantHost,
    audience: originalAudience,
    jwksUrl: originalJwksUrl,
    resourceAddress: originalResourceAddress,
    entryGroup: originalEntryGroup,
    enrollmentEnabled,
    enrollmentTeamAccountId,
    enrollmentReviewerProjectIds,
  } = originalGatewayConfig;
  config.set("twingate.gateway.enabled", enabled);
  config.set("twingate.gateway.tenantHost", originalTenantHost);
  config.set("twingate.gateway.audience", originalAudience);
  config.set("twingate.gateway.jwksUrl", originalJwksUrl);
  config.set("twingate.gateway.resourceAddress", originalResourceAddress);
  config.set("twingate.gateway.entryGroup", originalEntryGroup);
  config.set("twingate.gateway.enrollment.enabled", enrollmentEnabled);
  config.set(
    "twingate.gateway.enrollment.teamAccountId",
    enrollmentTeamAccountId,
  );
  config.set(
    "twingate.gateway.enrollment.reviewerProjectIds",
    enrollmentReviewerProjectIds,
  );
  config.set("server.url", originalServerUrl);
  config.set("server.wildcardDomains", originalWildcardDomains);
  await knex.destroy();
  poolConfig.max = originalPoolMax;
  knex.client.initializePool();
});

describe("Twingate Gateway browser authentication", () => {
  test("returns the verified diagnostic without mapping, writes, or cookies", async () => {
    await setupDatabase();
    const token = await signGatewayToken({
      subject: "unmapped-subject",
      email: "display-only@example.test",
    });
    const before = await Promise.all([
      UserSession.query().resultSize(),
      TwingateGatewayIdentity.query().resultSize(),
    ]);

    const res = await appRequest("/_twingate/me")
      .set(gatHeader(token))
      .expect(200);
    const { headers, body } = res;

    expect(headers["cache-control"]).toContain("no-store");
    expect(setCookies(res)).toEqual([]);
    expect(body).toEqual({
      subject: "unmapped-subject",
      email: "display-only@example.test",
      groups: [entryGroup],
    });
    expect(
      await Promise.all([
        UserSession.query().resultSize(),
        TwingateGatewayIdentity.query().resultSize(),
      ]),
    ).toEqual(before);
    expect(before).toEqual([0, 0]);
  });

  test("returns fixed no-store unauthorized responses for missing or forged assertions", async ({
    viewer,
  }) => {
    for (const headers of [{}, { "X-Twingate-GAT": "forged" }]) {
      const { text, headers: responseHeaders } = await appRequest("/config.js")
        .set(headers)
        .expect(401);
      expect(text).toBe("Unauthorized");
      expect(responseHeaders["cache-control"]).toContain("no-store");
      expect(responseHeaders["www-authenticate"]).toBe("Bearer");
    }
    expect(
      await UserSession.query().where("userId", viewer.user.id).resultSize(),
    ).toBe(0);
  });

  test("creates one real session only for a document navigation and retains it", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const token = await signGatewayToken({
      subject,
      email: "changed-but-not-linked@example.test",
    });

    const login = await appRequest("/projects?tab=recent")
      .set(gatHeader(token))
      .set("Sec-Fetch-Mode", "navigate")
      .set("Sec-Fetch-Dest", "document")
      .set("Accept", "text/html")
      .expect(303);

    expect(login.headers["location"]).toBe("/projects?tab=recent");
    const cookies = setCookies(login);
    const session = rawCookie(
      cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) ??
        "",
      SESSION_COOKIE_NAME,
    );
    expect(
      cookies.some((cookie) => cookie.startsWith(`${LOGGED_IN_COOKIE_NAME}=`)),
    ).toBe(true);

    const resolved = await resolveSession(session);
    expect(resolved?.userId).toBe(user.id);
    expect(
      await UserSession.query().where("userId", user.id).resultSize(),
    ).toBe(1);

    await appRequest("/config.js")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(session))
      .expect(200);
    const restoration = await appRequest("/")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(session))
      .set("Sec-Fetch-Mode", "navigate")
      .set("Sec-Fetch-Dest", "document")
      .set("Accept", "text/html");
    expect(
      setCookies(restoration).some((cookie) =>
        cookie.startsWith(`${LOGGED_IN_COOKIE_NAME}=`),
      ),
    ).toBe(true);
    expect(
      await UserSession.query().where("userId", user.id).resultSize(),
    ).toBe(1);
  });

  test("enrolls an unmapped document visitor with native contributor and reviewer access", async ({
    viewer,
  }) => {
    const { teamAccount, project } = await enableEnrollment();
    const { id: teamAccountId, teamId, slug: accountSlug } = teamAccount;
    const { id: projectId, name: projectName, token: projectToken } = project;
    const subject = "first-visit-subject";
    const token = await signGatewayToken({
      subject,
      email: "first-visit@example.test",
    });

    const login = await documentRequest(`/projects/${projectId}`, token).expect(
      303,
    );
    const session = rawCookie(
      setCookies(login).find((cookie) =>
        cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
      ) ?? "",
      SESSION_COOKIE_NAME,
    );
    const { user, account } = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });

    expect(user).toMatchObject({
      email: null,
      staff: false,
      type: "user",
      deletedAt: null,
    });
    expect(account).toMatchObject({
      userId: user.id,
      teamId: null,
    });
    expect(await UserEmail.query().where("userId", user.id).resultSize()).toBe(
      0,
    );
    expect(
      await TeamUser.query().where({ teamId, userId: user.id }).first(),
    ).toMatchObject({ userLevel: "contributor" });
    expect(
      await ProjectUser.query().where({ projectId, userId: user.id }).first(),
    ).toMatchObject({ userLevel: "reviewer" });
    expect((await resolveSession(session))?.userId).toBe(user.id);

    const projectResponse = await graphqlRequest({
      token,
      session,
      query: `
        query Project($accountSlug: String!, $projectName: String!) {
          project(accountSlug: $accountSlug, projectName: $projectName) {
            id
            token
          }
        }
      `,
      variables: { accountSlug, projectName },
    }).expect(200);
    expect(projectResponse.body.data.project).toMatchObject({
      id: projectId,
      token: projectToken,
    });
    const reviewBuild = await factory.Build.create({
      projectId,
      conclusion: "changes-detected",
    });
    const reviewMutation =
      "mutation Review($input: CreateBuildReviewInput!) { createBuildReview(input: $input) { id status } }";
    const review = await graphqlRequest({
      token,
      session,
      query: reviewMutation,
      variables: {
        input: {
          buildId: reviewBuild.id,
          event: "APPROVE",
          screenshotDiffReviews: [],
        },
      },
    }).expect(200);
    expect(review.body.errors).toBeUndefined();
    await expect(
      BuildReview.query().findOne({
        buildId: reviewBuild.id,
        userId: user.id,
      }),
    ).resolves.toMatchObject({ state: "approved" });

    const otherPrivateProject = await factory.Project.create({
      accountId: teamAccountId,
      name: `other-private-${projectId}`,
      private: true,
      defaultUserLevel: null,
    });
    const hiddenProject = await graphqlRequest({
      token,
      session,
      query: `
        query Project($accountSlug: String!, $projectName: String!) {
          project(accountSlug: $accountSlug, projectName: $projectName) { id }
        }
      `,
      variables: {
        accountSlug,
        projectName: otherPrivateProject.name,
      },
    }).expect(200);
    expect(hiddenProject.body.data.project).toBeNull();

    const selfGrant = await graphqlRequest({
      token,
      session,
      query: `
        mutation AddContributor($input: AddContributorToProjectInput!) {
          addOrUpdateProjectContributor(input: $input) { level }
        }
      `,
      variables: {
        input: {
          projectId,
          userAccountId: account.id,
          level: "admin",
        },
      },
    }).expect(200);
    expect(selfGrant.body.data).toBeNull();
    expect(
      await ProjectUser.query().where({ projectId, userId: user.id }).first(),
    ).toMatchObject({ userLevel: "reviewer" });

    const deletion = await graphqlRequest({
      token,
      session,
      query: "mutation DeleteProject($id: ID!) { deleteProject(id: $id) }",
      variables: { id: projectId },
    }).expect(200);
    expect(deletion.body.data).toBeNull();
    expect(await Project.query().findById(projectId)).toMatchObject({
      deletedAt: null,
    });

    const owner = await factory.User.create();
    const ownerAccount = await factory.UserAccount.create({ userId: owner.id });
    if (!teamId) {
      throw new Error("Expected a team account");
    }
    await TeamUser.query().insert({
      teamId,
      userId: owner.id,
      userLevel: "owner",
    });
    const ownerSubject = `owner-transition-${owner.id}`;
    await provisionGatewayIdentity({
      tenantHost,
      twingateUserId: ownerSubject,
      userId: owner.id,
    });
    const { rawToken: ownerSessionToken } = await createSession({
      userId: owner.id,
    });
    const ownerToken = await signGatewayToken({ subject: ownerSubject });
    const viewerLevel = await graphqlRequest({
      token: ownerToken,
      session: ownerSessionToken,
      query: `
        mutation AddContributor($input: AddContributorToProjectInput!) {
          addOrUpdateProjectContributor(input: $input) { level }
        }
      `,
      variables: {
        input: {
          projectId,
          userAccountId: account.id,
          level: "viewer",
        },
      },
    }).expect(200);
    expect(viewerLevel.body.errors).toBeUndefined();
    expect(
      await ProjectUser.query().where({ projectId, userId: user.id }).first(),
    ).toMatchObject({ userLevel: "viewer" });
    const deniedReview = await graphqlRequest({
      token,
      session,
      query: reviewMutation,
      variables: {
        input: {
          buildId: reviewBuild.id,
          event: "REJECT",
          screenshotDiffReviews: [],
        },
      },
    }).expect(200);
    expect(deniedReview.body.data).toBeNull();
    await expect(
      BuildReview.query().findOne({
        buildId: reviewBuild.id,
        userId: user.id,
      }),
    ).resolves.toMatchObject({ state: "approved" });

    const adminLevel = await graphqlRequest({
      token: ownerToken,
      session: ownerSessionToken,
      query: `
        mutation AddContributor($input: AddContributorToProjectInput!) {
          addOrUpdateProjectContributor(input: $input) { level }
        }
      `,
      variables: {
        input: {
          projectId,
          userAccountId: account.id,
          level: "admin",
        },
      },
    }).expect(200);
    expect(adminLevel.body.errors).toBeUndefined();
    const adminAction = await graphqlRequest({
      token,
      session,
      query: `
        mutation UpdatePrComment($input: UpdateProjectPrCommentInput!) {
          updateProjectPrComment(input: $input) { id }
        }
      `,
      variables: { input: { projectId, enabled: true } },
    }).expect(200);
    expect(adminAction.body.errors).toBeUndefined();
    expect(ownerAccount.id).not.toBe(account.id);

    expect(viewer.user.id).not.toBe(user.id);
  });

  test("creates exactly one identity graph for simultaneous first document requests", async () => {
    await setupDatabase();
    await enableEnrollment();
    const subject = "concurrent-first-visit";
    const token = await signGatewayToken({ subject });
    const usersBefore = await User.query().resultSize();

    const responses = await Promise.all([
      documentRequest("/projects", token),
      documentRequest("/projects", token),
      documentRequest("/projects", token),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(303);
    }

    const mappings = await TwingateGatewayIdentity.query().where({
      tenantHost,
      twingateUserId: subject,
    });
    expect(mappings).toHaveLength(1);
    const mapping = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });
    expect(await User.query().resultSize()).toBe(usersBefore + 1);
    expect(
      await Account.query()
        .where({ userId: mapping.user.id, teamId: null })
        .resultSize(),
    ).toBe(1);
    expect(
      await TeamUser.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);
    expect(
      await ProjectUser.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);
  });

  test("returns the committed manual binding when it wins the enrollment claim race", async () => {
    await setupDatabase();
    const { teamAccount } = await enableEnrollment();
    const manualUser = await factory.User.create();
    await factory.UserAccount.create({ userId: manualUser.id });
    const subject = "manual-binding-race-subject";
    const token = await signGatewayToken({ subject });
    const trx = await knex.transaction();
    const lockReached = Promise.withResolvers<void>();
    const onQuery = (query: { sql?: string }) => {
      if (
        query.sql?.includes('from "accounts"') &&
        query.sql.includes("for share")
      ) {
        lockReached.resolve();
      }
    };
    knex.on("query", onQuery);
    let committed = false;

    try {
      await Account.query(trx).findById(teamAccount.id).forUpdate();
      const enrollment = documentRequest("/projects", token).then(
        (response) => response,
      );
      await lockReached.promise;
      await provisionGatewayIdentity({
        tenantHost,
        twingateUserId: subject,
        userId: manualUser.id,
      });
      const usersBeforeRelease = await User.query().resultSize();
      await trx.commit();
      committed = true;

      expect((await enrollment).status).toBe(303);
      expect(await User.query().resultSize()).toBe(usersBeforeRelease);
      expect(
        await getGatewayMappedUser({ tenantHost, twingateUserId: subject }),
      ).toMatchObject({ user: { id: manualUser.id } });
      expect(
        await TeamUser.query().where("userId", manualUser.id).resultSize(),
      ).toBe(0);
      expect(
        await ProjectUser.query().where("userId", manualUser.id).resultSize(),
      ).toBe(0);
    } finally {
      knex.off("query", onQuery);
      if (!committed) {
        await trx.rollback();
      }
    }
  });

  test("rejects a valid foreign session before enrollment without revoking it", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    const foreign = await factory.User.create();
    await factory.UserAccount.create({ userId: foreign.id });
    const { rawToken, session } = await createSession({ userId: foreign.id });
    const subject = "foreign-cookie-subject";
    const token = await signGatewayToken({ subject });

    const response = await documentRequest(`/projects/${project.id}`, token)
      .set("Cookie", sessionCookie(rawToken))
      .expect(401);

    expect(
      setCookies(response).some((cookie) =>
        cookie.startsWith(`${SESSION_COOKIE_NAME}=;`),
      ),
    ).toBe(true);
    expect(await resolveSession(rawToken)).toEqual({
      sid: session.id,
      userId: foreign.id,
    });
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
  });

  test("does not treat invalid mapped identities as enrollment opportunities", async () => {
    const corruptions = [
      async (user: User, _teamAccount: Account) => {
        await user.$query().patch({ deletedAt: new Date().toISOString() });
      },
      async (user: User, _teamAccount: Account) => {
        await user.$query().patch({ type: "bot" });
      },
      async (user: User, _teamAccount: Account) => {
        await Account.query().delete().where("userId", user.id);
      },
    ];

    for (const corrupt of corruptions) {
      await setupDatabase();
      const { teamAccount } = await enableEnrollment();
      const user = await factory.User.create();
      await factory.UserAccount.create({ userId: user.id });
      const subject = `invalid-mapping-${user.id}`;
      await provisionGatewayIdentity({
        tenantHost,
        twingateUserId: subject,
        userId: user.id,
      });
      const usersBefore = await User.query().resultSize();
      await corrupt(user, teamAccount);

      await documentRequest(
        "/projects",
        await signGatewayToken({ subject }),
      ).expect(403);

      expect(await User.query().resultSize()).toBe(usersBefore);
      expect(
        await TwingateGatewayIdentity.query()
          .where({ tenantHost, twingateUserId: subject })
          .resultSize(),
      ).toBe(1);
    }
  });

  test("keeps existing mappings usable while enrollment is disabled for unseen subjects", async () => {
    await setupDatabase();
    const user = await factory.User.create();
    await factory.UserAccount.create({ userId: user.id });
    const mappedSubject = `enrollment-off-mapped-${user.id}`;
    await provisionGatewayIdentity({
      tenantHost,
      twingateUserId: mappedSubject,
      userId: user.id,
    });
    config.set("twingate.gateway.enrollment.enabled", false);

    await documentRequest(
      "/projects",
      await signGatewayToken({ subject: "enrollment-off-unseen" }),
    ).expect(403);
    await documentRequest(
      "/projects",
      await signGatewayToken({ subject: mappedSubject }),
    ).expect(303);
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: "enrollment-off-unseen" })
        .resultSize(),
    ).toBe(0);
  });

  test("enrolls after an invalid session cookie is rejected as unauthenticated", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    const subject = "invalid-cookie-subject";
    const token = await signGatewayToken({ subject });

    await documentRequest(`/projects/${project.id}`, token)
      .set("Cookie", sessionCookie("not-a-session"))
      .expect(303);

    await expect(
      getGatewayMappedUser({ tenantHost, twingateUserId: subject }),
    ).resolves.toMatchObject({ user: { email: null } });
  });

  test("lets an OAuth client exchange a code and refresh without an Argos session", async ({
    viewer,
  }) => {
    const { user, subject } = viewer;
    const token = await signGatewayToken({ subject });
    const redirectUri = "https://mcp-client.example/callback";
    const {
      client: { id: oauthClientId, clientId },
    } = await createDynamicClient({
      clientName: "Gateway OAuth client",
      redirectUris: [redirectUri],
    });
    const scopes = ["projects:read"];
    const grant = await OAuthGrant.query().insertAndFetch({
      userId: user.id,
      oauthClientId,
      scopes,
      lastUsedAt: null,
      revokedAt: null,
    });
    const codeVerifier = randomBytes(32).toString("base64url");
    const code = await createAuthorizationCode({
      grantId: grant.id,
      userId: user.id,
      clientId,
      redirectUri,
      scopes,
      accountIds: [],
      codeChallenge: createHash("sha256")
        .update(codeVerifier)
        .digest("base64url"),
      resource: null,
    });
    const tokenRequest = () =>
      request(app)
        .post("/oauth/token")
        .set("Host", resourceAddress)
        .set("X-Forwarded-Proto", "https")
        .type("form");

    await appRequest("/.well-known/oauth-authorization-server")
      .set(gatHeader(token))
      .expect(200);
    await tokenRequest()
      .send({
        grant_type: "refresh_token",
        refresh_token: "x",
        client_id: clientId,
      })
      .expect(401);
    const exchanged = await tokenRequest()
      .set(gatHeader(token))
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: clientId,
      })
      .expect(200);
    const { refresh_token: refreshToken } = exchanged.body;
    expect(exchanged.body).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
    await tokenRequest()
      .set(gatHeader(token))
      .send({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      })
      .expect(200);
    expect(await UserSession.query().resultSize()).toBe(0);
  });

  test("lets a subject enroll again after its user deletes their account", async ({
    viewer,
  }) => {
    const { user, account, subject } = viewer;
    await enableEnrollment();
    const token = await signGatewayToken({ subject });

    await deleteAccount({ id: account.id, user });

    await documentRequest("/projects", token).expect(303);
    const { user: enrolledUser } = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });
    expect(enrolledUser.id).not.toBe(user.id);
  });

  test("does not overwrite an enrolled profile when assertion email or policy changes", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    const subject = "profile-retention-subject";
    const firstToken = await signGatewayToken({
      subject,
      email: "first-profile@example.test",
    });
    await documentRequest(`/projects/${project.id}`, firstToken).expect(303);
    const { user, account } = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });
    await account.$query().patch({ name: "Edited profile" });
    config.set("twingate.gateway.enrollment.reviewerProjectIds", ["999999"]);

    await documentRequest(
      `/projects/${project.id}`,
      await signGatewayToken({
        subject,
        email: "changed-profile@example.test",
      }),
    ).expect(303);

    expect(await Account.query().findById(account.id)).toMatchObject({
      name: "Edited profile",
    });
    expect(
      await ProjectUser.query().where("userId", user.id).resultSize(),
    ).toBe(1);
  });

  test("rolls back enrollment when configured targets cannot be loaded", async () => {
    await setupDatabase();
    await enableEnrollment();
    config.set("twingate.gateway.enrollment.reviewerProjectIds", ["999999"]);
    const subject = "missing-target-subject";
    const token = await signGatewayToken({ subject });
    const usersBefore = await User.query().resultSize();

    await documentRequest("/projects", token).expect(503);

    expect(await User.query().resultSize()).toBe(usersBefore);
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
  });

  test("fails atomically when a configured reviewer project is transferred", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    const otherAccount = await factory.TeamAccount.create();
    await project.$query().patch({ accountId: otherAccount.id });
    const subject = "transferred-target-subject";
    const usersBefore = await User.query().resultSize();

    await documentRequest(
      "/projects",
      await signGatewayToken({ subject }),
    ).expect(503);

    expect(await User.query().resultSize()).toBe(usersBefore);
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
  });

  test("fails atomically when a configured reviewer project is deleted", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    await project.$query().patch({ deletedAt: new Date().toISOString() });
    const subject = "deleted-target-subject";
    const usersBefore = await User.query().resultSize();

    await documentRequest(
      "/projects",
      await signGatewayToken({ subject }),
    ).expect(503);

    expect(await User.query().resultSize()).toBe(usersBefore);
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
  });

  test("does not create identities for rejected Gateway assertions", async () => {
    await setupDatabase();
    await enableEnrollment();
    const usersBefore = await User.query().resultSize();
    const rejected = [
      { subject: "wrong-group-subject", groups: ["other-group"] },
      { subject: "expired-subject", expiresInSeconds: -60 },
      {
        subject: "wrong-resource-subject",
        resourceAddress: "other.argos-poc.internal",
      },
    ];

    for (const input of rejected) {
      const { subject, groups } = input;
      await documentRequest("/projects", await signGatewayToken(input)).expect(
        groups ? 403 : 401,
      );
      expect(
        await TwingateGatewayIdentity.query()
          .where({ tenantHost, twingateUserId: subject })
          .resultSize(),
      ).toBe(0);
    }
    await documentRequest("/projects", "forged").expect(401);
    expect(await User.query().resultSize()).toBe(usersBefore);
  });

  test("rolls back a candidate identity when its generated personal-account slug collides", async () => {
    await setupDatabase();
    await enableEnrollment();
    const { id, userId, slug } = await factory.UserAccount.create({
      slug: "tg-enrollment-collision",
    });
    const triggerName = "gateway_enrollment_slug_collision";
    const functionName = "gateway_enrollment_slug_collision_fn";
    const subject = "slug-collision-subject";
    const usersBefore = await User.query().resultSize();

    await knex.raw(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.slug LIKE 'tg-%' THEN
          NEW.slug := 'tg-enrollment-collision';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON accounts
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    try {
      await documentRequest(
        "/projects",
        await signGatewayToken({ subject }),
      ).expect(503);
    } finally {
      await knex.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON accounts`);
      await knex.raw(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    expect(await User.query().resultSize()).toBe(usersBefore);
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
    await expect(Account.query().findById(id)).resolves.toMatchObject({
      userId,
      slug,
    });
  });

  test("rolls back every candidate row when the final project grant fails", async () => {
    await setupDatabase();
    await enableEnrollment();
    const before = await Promise.all([
      User.query().resultSize(),
      Account.query().resultSize(),
      TwingateGatewayIdentity.query().resultSize(),
      TeamUser.query().resultSize(),
      ProjectUser.query().resultSize(),
    ]);
    await knex.raw(
      "ALTER TABLE project_users ADD CONSTRAINT gateway_enrollment_target_failure CHECK (\"userLevel\" <> 'reviewer') NOT VALID",
    );
    try {
      await documentRequest(
        "/projects",
        await signGatewayToken({ subject: "late-project-grant-failure" }),
      ).expect(503);
    } finally {
      await knex.raw(
        "ALTER TABLE project_users DROP CONSTRAINT gateway_enrollment_target_failure",
      );
    }
    expect(
      await Promise.all([
        User.query().resultSize(),
        Account.query().resultSize(),
        TwingateGatewayIdentity.query().resultSize(),
        TeamUser.query().resultSize(),
        ProjectUser.query().resultSize(),
      ]),
    ).toEqual(before);
  });

  test("never enrolls forged document navigation for reserved path aliases", async () => {
    await setupDatabase();
    await enableEnrollment();
    const subject = "reserved-path-subject";
    const token = await signGatewayToken({ subject });
    const paths = [
      "/graphql",
      "/graphql/../argos-poc/smoke",
      "/%67raphql",
      "/assets%2Fbundle.js",
      "/ASSETS/bundle.js/",
      "/auth/",
      "/oauth/token",
      "/m/share-token/poster/file.png",
      "/config.js/",
      "/favicon.ico",
    ];

    for (const path of paths) {
      await documentRequest(path, token).expect(403);
    }
    await expect(
      rawDocumentRequest("/graphql/../argos-poc/smoke", token),
    ).resolves.toBe(403);
    for (const requestWithUnsafeMethod of [
      request(app)
        .head("/projects")
        .set("Host", resourceAddress)
        .set(gatHeader(token))
        .set("Sec-Fetch-Mode", "navigate")
        .set("Sec-Fetch-Dest", "document")
        .set("Accept", "text/html"),
      request(app)
        .options("/projects")
        .set("Host", resourceAddress)
        .set(gatHeader(token))
        .set("Sec-Fetch-Mode", "navigate")
        .set("Sec-Fetch-Dest", "document")
        .set("Accept", "text/html"),
      request(app)
        .post("/projects")
        .set("Host", resourceAddress)
        .set(gatHeader(token))
        .set("Sec-Fetch-Mode", "navigate")
        .set("Sec-Fetch-Dest", "document")
        .set("Accept", "text/html"),
      documentRequest("/projects", token).set("Upgrade", "websocket"),
    ]) {
      await requestWithUnsafeMethod.expect(403);
    }
    expect(
      await TwingateGatewayIdentity.query()
        .where({ tenantHost, twingateUserId: subject })
        .resultSize(),
    ).toBe(0);
  });

  test("allows the OAuth authorize document route to enroll", async () => {
    await setupDatabase();
    await enableEnrollment();
    const subject = "oauth-authorize-subject";
    const token = await signGatewayToken({ subject });

    await documentRequest("/oauth/authorize", token).expect(303);

    await expect(
      getGatewayMappedUser({ tenantHost, twingateUserId: subject }),
    ).resolves.toMatchObject({ user: { email: null } });
  });

  test("retains a committed enrollment but returns 503 without cookies when session caching fails", async () => {
    await setupDatabase();
    const { project } = await enableEnrollment();
    const subject = "session-cache-failure-subject";
    const token = await signGatewayToken({ subject });
    const redis = await getRedisClient();
    const aclUser = `gateway_no_set_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2)}`;
    await redis.sendCommand([
      "ACL",
      "SETUSER",
      aclUser,
      "on",
      "nopass",
      "~rl:*",
      "+@all",
    ]);

    try {
      await redis.sendCommand(["AUTH", aclUser, ""]);
      const response = await documentRequest(
        `/projects/${project.id}`,
        token,
      ).expect(503);
      expect(setCookies(response)).toEqual([]);
    } finally {
      await redis.sendCommand(["AUTH", "default", ""]);
      await redis.sendCommand(["ACL", "DELUSER", aclUser]);
    }

    const mapping = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });
    expect(
      await TeamUser.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);
    expect(
      await ProjectUser.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);
    expect(
      await UserSession.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);

    await documentRequest(`/projects/${project.id}`, token).expect(303);
    expect(
      await getGatewayMappedUser({ tenantHost, twingateUserId: subject }),
    ).toMatchObject({ user: { id: mapping.user.id } });
    expect(
      await ProjectUser.query().where("userId", mapping.user.id).resultSize(),
    ).toBe(1);
  });

  test("does not reconcile removed enrollment grants for an existing identity", async () => {
    await setupDatabase();
    const { teamAccount, project } = await enableEnrollment();
    const subject = "existing-grants-subject";
    const token = await signGatewayToken({ subject });
    const login = await documentRequest(
      `/projects/${project.id}`,
      token,
    ).expect(303);
    const session = rawCookie(
      setCookies(login).find((cookie) =>
        cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
      ) ?? "",
      SESSION_COOKIE_NAME,
    );
    const mapping = await getGatewayMappedUser({
      tenantHost,
      twingateUserId: subject,
    });
    await TeamUser.query()
      .delete()
      .where({ teamId: teamAccount.teamId, userId: mapping.user.id });
    await ProjectUser.query()
      .delete()
      .where({ projectId: project.id, userId: mapping.user.id });

    await appRequest("/config.js")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(session))
      .expect(200);

    expect(
      await TeamUser.query()
        .where({ teamId: teamAccount.teamId, userId: mapping.user.id })
        .resultSize(),
    ).toBe(0);
    expect(
      await ProjectUser.query()
        .where({ projectId: project.id, userId: mapping.user.id })
        .resultSize(),
    ).toBe(0);
  });

  test("never bootstraps a session for GraphQL, assets, unsafe methods, or non-document navigation", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const token = await signGatewayToken({ subject });
    const requests = [
      appRequest("/graphql").set(gatHeader(token)),
      appRequest("/assets/not-present.js").set(gatHeader(token)),
      appRequest("/dashboard")
        .set(gatHeader(token))
        .set("Accept", "application/json"),
      request(app)
        .post("/graphql")
        .set("Host", resourceAddress)
        .set("X-Forwarded-Proto", "https")
        .set(gatHeader(token))
        .send({ query: "{ __typename }" }),
    ];

    for (const pending of requests) {
      await pending.expect(401);
    }
    expect(
      await UserSession.query().where("userId", user.id).resultSize(),
    ).toBe(0);
  });

  test("does not let a cookie rescue a missing assertion and clears a foreign session without revoking it", async ({
    viewer,
  }) => {
    const foreign = await factory.User.create();
    await factory.UserAccount.create({ userId: foreign.id });
    const { rawToken, session } = await createSession({ userId: foreign.id });
    const token = await signGatewayToken({ subject: viewer.subject });

    for (const path of [
      "/config.js",
      "/assets/not-present.js",
      "/unknown",
      "/graphql",
    ]) {
      await appRequest(path).set("Cookie", sessionCookie(rawToken)).expect(401);
    }

    const mismatch = await appRequest("/config.js")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(rawToken))
      .expect(401);
    expect(
      setCookies(mismatch).some((cookie) =>
        cookie.startsWith(`${SESSION_COOKIE_NAME}=;`),
      ),
    ).toBe(true);
    expect(await resolveSession(rawToken)).toEqual({
      sid: session.id,
      userId: foreign.id,
    });
  });

  test("keeps an explicit subject mapping when Gateway display email changes", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({
      subject,
      email: "renamed-in-twingate@example.test",
    });

    await appRequest("/_twingate/me")
      .set(gatHeader(token))
      .expect(200)
      .expect(({ body }) => {
        expect(body.email).toBe("renamed-in-twingate@example.test");
      });
    await appRequest("/config.js")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(session.rawToken))
      .expect(200);

    await expect(
      getGatewayMappedUser({ tenantHost, twingateUserId: subject }),
    ).resolves.toMatchObject({ user: { id: user.id } });
  });

  test("rejects valid Gateway identities without the configured group or mapping", async ({
    viewer,
  }) => {
    const missingGroup = await signGatewayToken({
      subject: viewer.subject,
      groups: ["Everyone", "twingate:member"],
    });
    const unmapped = await signGatewayToken({ subject: "different-subject" });

    await appRequest("/config.js").set(gatHeader(missingGroup)).expect(403);
    await appRequest("/config.js").set(gatHeader(unmapped)).expect(403);
  });

  test("enforces CSRF after matching Gateway identity and real session validation", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });

    await request(app)
      .post("/graphql")
      .set("Host", resourceAddress)
      .set("X-Forwarded-Proto", "https")
      .set(gatHeader(token))
      .set("Cookie", sessionCookie(session.rawToken))
      .send({ query: "{ __typename }" })
      .expect(403);
  });

  test("returns 503 instead of bootstrapping when the real database connection is unavailable", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });
    const settings = knex.client.connectionSettings;
    const originalHost = Reflect.get(settings, "host");
    const originalPort = Reflect.get(settings, "port");
    const originalAcquireTimeout = knex.client.config.acquireConnectionTimeout;
    const sessionsBefore = await UserSession.query()
      .where("userId", user.id)
      .resultSize();

    Reflect.set(settings, "host", "127.0.0.1");
    Reflect.set(settings, "port", 1);
    knex.client.config.acquireConnectionTimeout = 500;
    await knex.destroy();
    knex.client.initializePool();
    try {
      const { text, headers } = await appRequest("/dashboard")
        .set(gatHeader(token))
        .set("Cookie", sessionCookie(session.rawToken))
        .set("Sec-Fetch-Mode", "navigate")
        .set("Sec-Fetch-Dest", "document")
        .set("Accept", "text/html")
        .expect(503);
      expect(text).toBe("Service Unavailable");
      expect(headers["cache-control"]).toContain("no-store");
    } finally {
      await knex.destroy();
      Reflect.set(settings, "host", originalHost);
      Reflect.set(settings, "port", originalPort);
      knex.client.config.acquireConnectionTimeout = originalAcquireTimeout;
      knex.client.initializePool();
    }

    expect(
      await UserSession.query().where("userId", user.id).resultSize(),
    ).toBe(sessionsBefore);
  });

  test("makes subject and user uniqueness conflicts fail without reassignment", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const other = await factory.User.create();
    await factory.UserAccount.create({ userId: other.id });
    const otherSubject = "another-twingate-user";
    await provisionGatewayIdentity({
      tenantHost,
      twingateUserId: otherSubject,
      userId: other.id,
    });

    await expect(
      provisionGatewayIdentity({
        tenantHost,
        twingateUserId: subject,
        userId: other.id,
      }),
    ).rejects.toBeDefined();
    await expect(
      provisionGatewayIdentity({
        tenantHost,
        twingateUserId: otherSubject,
        userId: user.id,
      }),
    ).rejects.toBeDefined();

    expect(
      await TwingateGatewayIdentity.query().findOne({
        tenantHost,
        twingateUserId: subject,
      }),
    ).toMatchObject({ userId: user.id });
    expect(
      await TwingateGatewayIdentity.query().findOne({
        tenantHost,
        twingateUserId: otherSubject,
      }),
    ).toMatchObject({ userId: other.id });
  });

  test("does not grant project ownership to an unrelated mapped identity", async ({
    viewer,
  }) => {
    const owner = await factory.User.create();
    const ownerAccount = await factory.UserAccount.create({ userId: owner.id });
    const project = await factory.Project.create({
      accountId: ownerAccount.id,
      private: true,
    });
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });
    const query = "mutation DeleteProject($id: ID!) { deleteProject(id: $id) }";
    const {
      body: { data, errors },
    } = await graphqlRequest({
      token,
      session: session.rawToken,
      query,
      variables: { id: project.id },
    }).expect(200);

    expect(data).toBeNull();
    expect(errors).toEqual([
      expect.objectContaining({ path: ["deleteProject"] }),
    ]);
    expect(await Project.query().findById(project.id)).toMatchObject({
      deletedAt: null,
    });

    const ownerSubject = "project-owner-" + owner.id;
    await provisionGatewayIdentity({
      tenantHost,
      twingateUserId: ownerSubject,
      userId: owner.id,
    });
    const ownerSession = await createSession({ userId: owner.id });
    const {
      body: { data: ownerData, errors: ownerErrors },
    } = await graphqlRequest({
      token: await signGatewayToken({ subject: ownerSubject }),
      session: ownerSession.rawToken,
      query,
      variables: { id: project.id },
    }).expect(200);
    expect(ownerErrors).toBeUndefined();
    expect(ownerData).toEqual({ deleteProject: true });
    expect(
      (await Project.query().findById(project.id).throwIfNotFound()).deletedAt,
    ).not.toBeNull();
  });

  test("keeps enforced SAML teams closed to twingate-authenticated memberships", async ({
    viewer,
  }) => {
    const plan = await factory.Plan.create({ samlIncluded: true });
    const { subject, user } = viewer;
    const { id: accountId, teamId, slug } = await factory.TeamAccount.create();
    if (!teamId) {
      throw new Error("Expected team account");
    }
    await factory.Subscription.create({
      accountId,
      planId: plan.id,
      status: "active",
      endDate: null,
    });
    await TeamSamlConfig.query().insert({
      accountId,
      idpEntityId: "https://idp.example.test/entity",
      ssoUrl: "https://idp.example.test/login",
      signingCertificate: "test-certificate",
      enabled: true,
      enforced: true,
      enforcedAt: new Date().toISOString(),
    });
    await factory.TeamUser.create({
      teamId,
      userId: user.id,
      userLevel: "member",
      lastAuthMethod: "twingate",
    });
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });

    const {
      body: { data, errors },
    } = await graphqlRequest({
      token,
      session: session.rawToken,
      query: "query Account($slug: String!) { account(slug: $slug) { id } }",
      variables: { slug },
    }).expect(200);

    expect(data.account).toBeNull();
    expect(errors[0].extensions.argosErrorCode).toBe("SAML_SSO_REQUIRED");
  });
});

describe("Gateway-mode native authentication lockdown", () => {
  test("rejects email and passkey GraphQL entry points before their normal side effects", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });
    const mutations = [
      'mutation { requestEmailSignup(email: "new-user@example.test") }',
      'mutation { requestEmailSignin(email: "new-user@example.test") }',
      'mutation { authenticateWithEmail(input: { email: "new-user@example.test", code: "unused" }) { creation } }',
      "mutation { createPasskeyRegistrationOptions { challengeId } }",
      "mutation { createPasskeyAuthenticationOptions { challengeId } }",
    ];

    for (const query of mutations) {
      const response = await graphqlRequest({
        token,
        session: session.rawToken,
        query,
      }).expect(200);
      expect(response.body.errors[0].extensions.argosErrorCode).toBe(
        "GATEWAY_MANAGED_AUTH",
      );
    }
  });

  test("rejects OAuth and SAML completion before contacting their providers", async () => {
    await setupDatabase();

    for (const path of [
      "/auth/github",
      "/auth/gitlab",
      "/auth/google",
      "/auth/saml",
    ]) {
      await request(app)
        .post(path)
        .set("Host", "api.argos-ci.dev")
        .set("X-Forwarded-Proto", "https")
        .send({ code: "must-not-be-exchanged" })
        .expect(403);
    }
  });
});

describe("disabled notification delivery", () => {
  test("does not mark a disabled email message as sent", async () => {
    await setupDatabase();
    const user = await factory.User.create({
      email: "mail-disabled@example.test",
    });
    await factory.UserAccount.create({ userId: user.id });
    const workflow = await NotificationWorkflow.query().insertAndFetch({
      type: "welcome",
      data: {},
      jobStatus: "pending",
    });
    const message = await NotificationMessage.query().insertAndFetch({
      userId: user.id,
      workflowId: workflow.id,
      channel: "email",
      jobStatus: "pending",
      sentAt: null,
      deliveredAt: null,
      linkClickedAt: null,
      externalId: null,
    });

    config.set("email.enabled", false);
    try {
      await notificationMessageJob.run(message.id, {
        logger: logger.child({ module: "disabled-email-test" }),
      });
    } finally {
      config.set("email.enabled", originalEmailEnabled);
    }

    expect(
      await NotificationMessage.query().findById(message.id),
    ).toMatchObject({
      id: message.id,
      jobStatus: "complete",
      sentAt: null,
      externalId: null,
    });
  });
});

async function withGraphQLServer(
  callback: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  createGraphQLWebSocketServer(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("GraphQL test server did not expose a TCP port");
  }
  const url = `ws://127.0.0.1:${address.port}/graphql`;

  try {
    await callback(url);
  } finally {
    server.close();
    await once(server, "close");
  }
}

interface ExpectWsUpgradeStatusProps {
  url: string;
  headers: Record<string, string>;
  status: number;
}

async function expectWsUpgradeStatus(
  props: ExpectWsUpgradeStatusProps,
): Promise<void> {
  const { url, headers, status } = props;
  const result = Promise.withResolvers<number>();
  const socket = new WebSocket(url, { headers });
  socket.once("unexpected-response", (_request, response) => {
    response.resume();
    result.resolve(response.statusCode ?? 0);
  });
  socket.once("open", () =>
    result.reject(new Error("WebSocket unexpectedly upgraded")),
  );
  socket.once("error", () => undefined);
  await expect(result.promise).resolves.toBe(status);
}

interface CreateGatewayWsClientProps {
  url: string;
  getToken: () => string;
  cookie: string;
  onConnected: () => void;
  onClosed: (code: number) => void;
  onRetry: () => Promise<void>;
}

function createGatewayWsClient(props: CreateGatewayWsClientProps) {
  const { url, getToken, cookie, onConnected, onClosed, onRetry } = props;
  class GatewayWebSocket extends WebSocket {
    constructor(address: string, protocols: string | string[]) {
      super(address, protocols, {
        headers: {
          Host: resourceAddress,
          Cookie: cookie,
          Origin: `https://${resourceAddress}`,
          "X-Twingate-GAT": getToken(),
        },
      });
    }
  }

  return createClient({
    url,
    webSocketImpl: GatewayWebSocket,
    retryAttempts: 1,
    retryWait: onRetry,
    on: {
      connected: onConnected,
      closed: (event) => {
        if (
          typeof event !== "object" ||
          event === null ||
          !("code" in event) ||
          typeof event.code !== "number"
        ) {
          throw new Error("Expected a WebSocket close event");
        }
        onClosed(event.code);
      },
    },
  });
}

describe("Gateway GraphQL WebSockets", () => {
  test("rejects invalid Gateway WebSocket handshakes before HTTP upgrade", async ({
    viewer,
  }) => {
    const { subject, user } = viewer;
    const session = await createSession({ userId: user.id });
    const token = await signGatewayToken({ subject });
    const unmapped = await signGatewayToken({ subject: "unmapped-ws-user" });

    await withGraphQLServer(async (url) => {
      await expectWsUpgradeStatus({
        url,
        headers: {
          Host: resourceAddress,
          Origin: `https://${resourceAddress}`,
        },
        status: 401,
      });
      await expectWsUpgradeStatus({
        url,
        headers: {
          Host: resourceAddress,
          Origin: "https://attacker.example.test",
          Cookie: sessionCookie(session.rawToken),
          "X-Twingate-GAT": token,
        },
        status: 401,
      });
      await expectWsUpgradeStatus({
        url,
        headers: {
          Host: resourceAddress,
          Origin: `https://${resourceAddress}`,
          Cookie: sessionCookie(session.rawToken),
          "X-Twingate-GAT": unmapped,
        },
        status: 403,
      });
      await expectWsUpgradeStatus({
        url,
        headers: {
          Host: resourceAddress,
          Origin: `https://${resourceAddress}`,
          "X-Twingate-GAT": token,
        },
        status: 401,
      });
      await expectWsUpgradeStatus({
        url,
        headers: {
          Host: "wrong.argos-poc.internal",
          Origin: `https://${resourceAddress}`,
          Cookie: sessionCookie(session.rawToken),
          "X-Twingate-GAT": token,
        },
        status: 401,
      });
    });
  });

  test.for([
    "session revocation",
    "mapping removal",
    "user invalidation",
  ] as const)(
    "rejects a subsequent operation on the same live socket after %s while the GAT remains valid",
    async (invalidation, { viewer }) => {
      const { subject, user, account } = viewer;
      const { rawToken, session } = await createSession({ userId: user.id });
      const token = await signGatewayToken({
        subject,
        expiresInSeconds: 3600,
      });

      await withGraphQLServer(async (url) => {
        const socket = new WebSocket(url, "graphql-transport-ws", {
          headers: {
            Host: resourceAddress,
            Cookie: sessionCookie(rawToken),
            Origin: `https://${resourceAddress}`,
            "X-Twingate-GAT": token,
          },
        });
        const closed = once(socket, "close");
        const messages = on(socket, "message", { close: ["close"] });
        const readMessage = async () => {
          const message = await messages.next();
          if (message.done) {
            throw new Error("WebSocket closed before the expected response");
          }
          return JSON.parse(message.value[0].toString());
        };

        try {
          await once(socket, "open");
          socket.send(JSON.stringify({ type: "connection_init" }));
          expect(await readMessage()).toEqual({ type: "connection_ack" });
          socket.send(
            JSON.stringify({
              id: "authenticated",
              type: "subscribe",
              payload: { query: "{ me { id } }" },
            }),
          );
          expect(await readMessage()).toEqual({
            id: "authenticated",
            type: "next",
            payload: { data: { me: { id: account.id } } },
          });
          expect(await readMessage()).toEqual({
            id: "authenticated",
            type: "complete",
          });

          switch (invalidation) {
            case "session revocation":
              await revokeSession({
                sessionId: session.id,
                userId: user.id,
              });
              expect(await resolveSession(rawToken)).toBeNull();
              break;
            case "mapping removal":
              await TwingateGatewayIdentity.query().delete().where({
                tenantHost,
                twingateUserId: subject,
              });
              break;
            case "user invalidation":
              await user.$query().patch({
                deletedAt: new Date().toISOString(),
              });
              break;
          }

          expect(socket.readyState).toBe(WebSocket.OPEN);
          expect(decodeJwt(token).exp).toBeGreaterThan(Date.now() / 1000 + 60);
          socket.send(
            JSON.stringify({
              id: "invalidated",
              type: "subscribe",
              payload: { query: "{ me { id } }" },
            }),
          );
          expect((await messages.next()).done).toBe(true);
          const [code] = await closed;
          expect(code).toBeGreaterThanOrEqual(4000);
          expect(decodeJwt(token).exp).toBeGreaterThan(Date.now() / 1000 + 60);
        } finally {
          socket.close();
          await closed;
          await messages.return?.(undefined);
        }
      });
    },
  );

  test("closes on GAT expiry, retries with a fresh assertion, and receives a resubscribed event", async ({
    viewer,
  }) => {
    const { subject, user, account } = viewer;
    const session = await createSession({ userId: user.id });
    let token = await signGatewayToken({
      subject,
      expiresInSeconds: 1,
    });
    let refreshedToken: Promise<string> | null = null;
    const expiry = Promise.withResolvers<void>();
    const reconnected = Promise.withResolvers<void>();
    let receivedEvent: unknown;
    let subscriptionError: unknown;
    const fail = (error: unknown) => {
      subscriptionError = error;
      expiry.reject(error);
      reconnected.reject(error);
    };

    await withGraphQLServer(async (url) => {
      const client = createGatewayWsClient({
        url,
        getToken: () => token,
        cookie: sessionCookie(session.rawToken),
        onConnected: () => {
          // The initial assertion can expire before its connection_ack arrives.
          if (refreshedToken) {
            reconnected.resolve();
          }
        },
        onClosed: (code) => {
          if (refreshedToken) {
            return;
          }
          if (code !== 4403) {
            const error = new Error(
              `Expected Gateway expiry close, got ${code}`,
            );
            fail(error);
            return;
          }
          refreshedToken = signGatewayToken({
            subject,
            expiresInSeconds: 60,
          });
          expiry.resolve();
        },
        onRetry: async () => {
          if (!refreshedToken) {
            throw new Error("Gateway client retried before expiry");
          }
          token = await refreshedToken;
        },
      });

      try {
        client.subscribe(
          {
            query:
              "subscription Presence($userId: ID!) { userPresenceChanged(userId: $userId) { user { id } } }",
            variables: { userId: user.id },
          },
          {
            next: (value) => {
              receivedEvent = value;
            },
            error: fail,
            complete: () =>
              fail(new Error("Subscription completed before presence event")),
          },
        );

        await expiry.promise;
        await reconnected.promise;

        // A connection_ack precedes per-operation auth and Redis SUBSCRIBE.
        // Publish real events until one traverses the re-established stream.
        await expect
          .poll(
            async () => {
              if (subscriptionError) {
                throw subscriptionError;
              }
              await publishUserPresenceChanged({ userId: user.id });
              return receivedEvent;
            },
            { timeout: 5_000 },
          )
          .toMatchObject({
            data: { userPresenceChanged: { user: { id: account.id } } },
          });
      } finally {
        await client.dispose();
      }
    });
  });

  test("retains anonymous WebSocket behavior when Gateway mode is disabled", async () => {
    await setupDatabase();
    config.set("twingate.gateway.enabled", false);

    try {
      await withGraphQLServer(async (url) => {
        const result = Promise.withResolvers<unknown>();
        class AnonymousWebSocket extends WebSocket {
          constructor(address: string, protocols: string | string[]) {
            super(address, protocols, {
              headers: {
                Host: resourceAddress,
                Origin: `https://${resourceAddress}`,
              },
            });
          }
        }

        const client = createClient({
          url,
          webSocketImpl: AnonymousWebSocket,
          retryAttempts: 0,
        });
        client.subscribe(
          { query: "{ __typename }" },
          {
            next: result.resolve,
            error: result.reject,
            complete: () =>
              result.reject(
                new Error("Anonymous query completed without a result"),
              ),
          },
        );
        await expect(result.promise).resolves.toMatchObject({
          data: { __typename: "Query" },
        });
        client.dispose();
      });
    } finally {
      config.set("twingate.gateway.enabled", true);
    }
  });
});
