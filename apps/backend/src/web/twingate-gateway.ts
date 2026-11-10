import type { IncomingMessage } from "node:http";
import type { Request, RequestHandler, Response } from "express";

import { completeLogin } from "@/auth/login";
import type { AuthSessionPayload } from "@/auth/payload";
import {
  clearSessionCookies,
  LOGGED_IN_COOKIE_NAME,
  setLoggedInCookie,
} from "@/auth/session-cookie";
import { sessionAuthFromExpressReq } from "@/auth/session-request";
import { verifyGatewayRequest } from "@/auth/twingate-gateway";
import config from "@/config";
import {
  enrollGatewayIdentity,
  findGatewayMappedUser,
  getGatewayMappedUser,
  type GatewayMappedUser,
} from "@/database/services/twingate-gateway";
import { boom, HTTPError } from "@/util/error";

class GatewaySessionMismatchError extends Error {}

export function toGatewayError(error: unknown): HTTPError {
  if (
    error instanceof HTTPError &&
    (error.statusCode === 401 ||
      error.statusCode === 403 ||
      error.statusCode === 503)
  ) {
    return error;
  }
  return boom(503, "Service Unavailable");
}

function sendGatewayError(response: Response, error: unknown): void {
  const { statusCode } = toGatewayError(error);
  response.setHeader("Cache-Control", "no-store");
  if (statusCode === 401) {
    response.setHeader("WWW-Authenticate", "Bearer");
  }
  response.sendStatus(statusCode);
}

async function getMatchingGatewaySession(
  request: Pick<Request, "headers">,
  mapping: GatewayMappedUser,
): Promise<AuthSessionPayload> {
  const auth = await sessionAuthFromExpressReq(request);
  const { user, account } = auth;
  if (user.id !== mapping.user.id || account.id !== mapping.account.id) {
    throw new GatewaySessionMismatchError();
  }

  return auth;
}

function isReservedDocumentPath(pathname: string): boolean {
  const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const reservedFamilies = [
    "/graphql",
    "/_twingate",
    "/assets",
    "/icons",
    "/static",
    "/.well-known",
    "/scim",
    "/invoices",
    "/auth",
    "/slack",
    "/notification-preview",
    "/email-preview",
    "/oembed",
  ];
  const reservedExact = [
    "/config.js",
    "/auth.md",
    "/manifest.json",
    "/robots.txt",
    "/browserconfig.xml",
    "/favicon.ico",
    "/index.html",
  ];

  if (
    reservedExact.includes(path) ||
    reservedFamilies.some(
      (family) => path === family || path.startsWith(`${family}/`),
    )
  ) {
    return true;
  }

  if (path === "/oauth/authorize") {
    return false;
  }
  if (path === "/oauth" || path.startsWith("/oauth/")) {
    return true;
  }

  return /^\/m\/[^/]+\/poster\/[^/]+$/.test(path);
}

/**
 * OAuth clients authenticate to these endpoints themselves and never hold an
 * Argos browser session. The consent page, `/oauth/authorize`, is not one of
 * them: it stays behind the session like any other document.
 */
function isOAuthProtocolRequest(request: Request): boolean {
  const { method } = request;
  const path = request.path.toLowerCase().replace(/\/+$/, "");
  if (method === "GET" || method === "HEAD") {
    return path === "/.well-known/oauth-authorization-server";
  }
  return (
    method === "POST" &&
    [
      "/oauth/token",
      "/oauth/register",
      "/oauth/introspect",
      "/oauth/revoke",
    ].includes(path)
  );
}

function isDocumentNavigation(request: Request): boolean {
  const { method, originalUrl } = request;
  if (
    method !== "GET" ||
    request.get("upgrade") !== undefined ||
    request.get("sec-fetch-mode") !== "navigate" ||
    request.get("sec-fetch-dest") !== "document" ||
    !request.get("accept")?.includes("text/html")
  ) {
    return false;
  }

  const originalPathname = originalUrl.split(/[?#]/, 1)[0] ?? "";
  if (!originalPathname.startsWith("/")) {
    return false;
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(originalPathname);
  } catch {
    return false;
  }
  if (decodedPathname.includes("\0") || decodedPathname.includes("\\")) {
    return false;
  }

  let normalizedPathname: string;
  try {
    normalizedPathname = new URL(decodedPathname, "http://localhost").pathname;
  } catch {
    return false;
  }

  return ![originalPathname, decodedPathname, normalizedPathname].some(
    isReservedDocumentPath,
  );
}

function hasLoggedInCookie(request: Request): boolean {
  return (
    request.headers.cookie
      ?.split(";")
      .some((part) => part.trim() === `${LOGGED_IN_COOKIE_NAME}=1`) ?? false
  );
}

function getSafeRequestRedirect(request: Request): string {
  const origin = new URL(config.get("server.url")).origin;
  try {
    const target = new URL(request.originalUrl, origin);
    if (target.origin === origin) {
      return `${target.pathname}${target.search}`;
    }
  } catch {
    // Invalid redirect URLs must not prevent session bootstrap.
  }
  return "/";
}

async function bootstrapGatewaySession(
  request: Request,
  response: Response,
  mapping: GatewayMappedUser,
): Promise<void> {
  await completeLogin({
    req: request,
    res: response,
    userId: mapping.user.id,
    method: "twingate",
    creation: false,
  });
  response.setHeader("Cache-Control", "no-store");
  response.redirect(303, getSafeRequestRedirect(request));
}

/**
 * Verify that the Gateway identity, explicit Argos mapping, and existing
 * browser session all name the same user. WebSocket upgrades use this because
 * they cannot bootstrap a browser session.
 */
export async function verifyGatewaySession(
  request: Pick<IncomingMessage, "headers" | "rawHeaders">,
): Promise<{ auth: AuthSessionPayload; expiresAt: number }> {
  const { tenantHost, subject, expiresAt } =
    await verifyGatewayRequest(request);
  const mapping = await getGatewayMappedUser({
    tenantHost,
    twingateUserId: subject,
  });
  try {
    const auth = await getMatchingGatewaySession(request, mapping);
    return { auth, expiresAt };
  } catch (error) {
    if (error instanceof GatewaySessionMismatchError) {
      throw boom(401, "Unauthorized");
    }
    throw error;
  }
}

/**
 * Enforce Gateway identity for every app request when Gateway authentication is
 * enabled. The diagnostic endpoint and the OAuth protocol endpoints verify only
 * the signed identity and entry-group membership; the diagnostic endpoint never
 * reads the database or cookies.
 */
export function createTwingateGatewayMiddleware(): RequestHandler {
  return async (request, response, next) => {
    if (!config.get("twingate.gateway.enabled")) {
      next();
      return;
    }

    try {
      const identity = await verifyGatewayRequest(request);
      const { tenantHost, subject, email, groups } = identity;

      const { method, path } = request;
      if (method === "GET" && path === "/_twingate/me") {
        response.setHeader("Cache-Control", "no-store");
        response.json({ subject, email, groups });
        return;
      }

      if (isOAuthProtocolRequest(request)) {
        next();
        return;
      }

      let mapping = await findGatewayMappedUser({
        tenantHost,
        twingateUserId: subject,
      });

      if (!mapping) {
        if (
          !config.get("twingate.gateway.enrollment.enabled") ||
          !isDocumentNavigation(request)
        ) {
          throw boom(403, "Forbidden");
        }

        let suppliedSession: AuthSessionPayload | null = null;
        try {
          suppliedSession = await sessionAuthFromExpressReq(request);
        } catch (error) {
          const gatewayError = toGatewayError(error);
          if (gatewayError.statusCode !== 401) {
            throw gatewayError;
          }
        }
        if (suppliedSession) {
          clearSessionCookies(response);
          sendGatewayError(response, boom(401, "Unauthorized"));
          return;
        }

        mapping = await enrollGatewayIdentity({
          identity,
          policy: {
            teamAccountId: config.get(
              "twingate.gateway.enrollment.teamAccountId",
            ),
            reviewerProjectIds: config.get(
              "twingate.gateway.enrollment.reviewerProjectIds",
            ),
          },
        });
        await bootstrapGatewaySession(request, response, mapping);
        return;
      }

      try {
        await getMatchingGatewaySession(request, mapping);
      } catch (error) {
        if (error instanceof GatewaySessionMismatchError) {
          clearSessionCookies(response);
          sendGatewayError(response, boom(401, "Unauthorized"));
          return;
        }

        const gatewayError = toGatewayError(error);
        if (gatewayError.statusCode !== 401) {
          throw gatewayError;
        }

        if (!isDocumentNavigation(request)) {
          throw gatewayError;
        }

        await bootstrapGatewaySession(request, response, mapping);
        return;
      }

      if (isDocumentNavigation(request) && !hasLoggedInCookie(request)) {
        setLoggedInCookie(response);
      }

      next();
    } catch (error) {
      sendGatewayError(response, error);
    }
  };
}
