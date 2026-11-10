import type { IncomingMessage, Server } from "node:http";
import { invariant } from "@argos/util/invariant";
import { GraphQLError } from "graphql";
import { CloseCode, type SubscribePayload } from "graphql-ws";
import { useServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { AuthSessionPayload } from "@/auth/payload";
import config from "@/config";
import parentLogger from "@/logger";
import { HTTPError } from "@/util/error";
import { toGatewayError, verifyGatewaySession } from "@/web/twingate-gateway";

import { createWebSocketContext, getWebSocketContext } from "./context";
import { schema } from "./schema";

const logger = parentLogger.child({ module: "graphql-ws" });

interface GatewayWebSocketSession {
  expiresAt: number;
}

/**
 * Only accept WebSocket upgrades coming from our own app. The session cookie is
 * sent automatically on the upgrade request and — unlike the HTTP transport — a
 * WebSocket handshake cannot carry our CSRF header, so we guard against
 * cross-site WebSocket hijacking by validating the Origin against the
 * configured public URL and wildcard domains.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  // Non-browser clients omit Origin and are not subject to cross-site
  // hijacking (they carry no ambient cookies); browsers always send it.
  if (!origin) {
    return true;
  }
  // Compare on hostname (not host) so the port the app runs on — e.g. the Vite
  // dev server proxying to the backend — does not cause a false rejection.
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === new URL(config.get("server.url")).hostname) {
    return true;
  }
  return config
    .get("server.wildcardDomains")
    .some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isAppHostname(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) {
    return false;
  }
  try {
    return (
      new URL("https://" + host).hostname ===
      new URL(config.get("server.url")).hostname
    );
  } catch {
    return false;
  }
}

function scheduleGatewayExpiry(
  socket: WebSocket,
  request: IncomingMessage,
  sessions: WeakMap<IncomingMessage, GatewayWebSocketSession>,
  expiresAt: number,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeWhenExpired = () => {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      socket.close(4403, "Twingate token expired");
      return;
    }
    timer = setTimeout(closeWhenExpired, Math.min(remainingMs, 2_147_483_647));
  };

  closeWhenExpired();
  socket.once("close", () => {
    clearTimeout(timer);
    sessions.delete(request);
  });
}

/**
 * Attach a graphql-ws WebSocket server to the HTTP server so GraphQL
 * subscriptions are served over /graphql — the same path as queries and
 * mutations, since WebSocket upgrades and plain HTTP requests do not collide.
 */
export function createGraphQLWebSocketServer(httpServer: Server): void {
  const gatewaySessions = new WeakMap<
    IncomingMessage,
    GatewayWebSocketSession
  >();
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
    verifyClient: (info, done) => {
      if (!config.get("twingate.gateway.enabled")) {
        done(true);
        return;
      }

      void (async () => {
        try {
          if (
            !isAppHostname(info.req) ||
            !isAllowedOrigin(info.req.headers.origin)
          ) {
            done(false, 401, undefined, {
              "Cache-Control": "no-store",
              "WWW-Authenticate": "Bearer",
            });
            return;
          }
          const { expiresAt } = await verifyGatewaySession(info.req);
          gatewaySessions.set(info.req, { expiresAt });
          done(true);
        } catch (error) {
          const { statusCode } = toGatewayError(error);
          done(false, statusCode, undefined, {
            "Cache-Control": "no-store",
            ...(statusCode === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
          });
        }
      })();
    },
  });

  wsServer.on("connection", (socket, request) => {
    if (!config.get("twingate.gateway.enabled")) {
      return;
    }
    const session = gatewaySessions.get(request);
    invariant(
      session,
      "verifyClient stores a Gateway session before accepting the upgrade",
    );
    scheduleGatewayExpiry(socket, request, gatewaySessions, session.expiresAt);
  });

  // graphql-ws hands the same payload object to onSubscribe and context, so it
  // carries the session onSubscribe verified to that operation's context.
  const gatewayOperationAuth = new WeakMap<
    SubscribePayload,
    AuthSessionPayload
  >();

  useServer(
    {
      schema,
      // Revalidating here rather than in `context` lets a rejected session
      // close the socket with an auth code: graphql-ws logs anything thrown
      // while handling a message as a server bug and closes with 4500.
      onSubscribe: async (ctx, _id, payload) => {
        if (!config.get("twingate.gateway.enabled")) {
          return undefined;
        }
        try {
          const { auth } = await verifyGatewaySession(ctx.extra.request);
          gatewayOperationAuth.set(payload, auth);
          return undefined;
        } catch (error) {
          if (
            !(error instanceof HTTPError) ||
            (error.statusCode !== 401 && error.statusCode !== 403)
          ) {
            throw error;
          }
          ctx.extra.socket.close(
            error.statusCode === 401
              ? CloseCode.Unauthorized
              : CloseCode.Forbidden,
            error.message,
          );
          return [new GraphQLError(error.message)];
        }
      },
      context: (ctx, _id, payload) => {
        if (!config.get("twingate.gateway.enabled")) {
          return getWebSocketContext(ctx.extra.request);
        }
        const auth = gatewayOperationAuth.get(payload);
        invariant(auth, "onSubscribe verifies the Gateway session first");
        return createWebSocketContext(auth);
      },
      onConnect: (ctx) => {
        const { origin } = ctx.extra.request.headers;
        if (!isAllowedOrigin(origin)) {
          logger.warn(
            { origin },
            "Rejected WebSocket connection from disallowed origin",
          );
          return false;
        }
        return true;
      },
    },
    wsServer,
  );
}
