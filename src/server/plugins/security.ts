import type { FastifyInstance, FastifyRequest } from "fastify";
import { isAllowedHost } from "../auth/host.js";
import { SESSION_COOKIE } from "../auth/cookie.js";
import { bearerFrom, guardFor, isOriginAllowed } from "../auth/identity.js";
import type { Guard, Identity } from "../auth/identity.js";

export interface SecurityOptions {
  allowedHosts: readonly string[];
}

const CHALLENGE = 'Bearer realm="slide-studio"';
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function registerSecurity(
  app: FastifyInstance,
  { allowedHosts }: SecurityOptions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isAllowedHost(request.headers.host, allowedHosts)) return;
    return reply.code(421).send({ error: "This Host header is not allowed." });
  });

  app.addHook("onRequest", async (request, reply) => {
    request.identity = resolve(app, request);
    const guard = guardOf(request);
    if (guard === "none") return;
    if (app.authMode === "open") return;

    const identity = request.identity;
    if (identity === null) {
      return reply
        .code(401)
        .header("WWW-Authenticate", CHALLENGE)
        .send({ error: "Sign in, or send Authorization: Bearer <token>." });
    }
    // A valid credential of the wrong kind is a 403: retrying with the same
    // credential can never succeed, so a challenge would be a lie.
    if (guard !== "any" && guard !== identity.kind) {
      return reply
        .code(403)
        .send({ error: `This endpoint needs a ${guard} credential.` });
    }
    if (
      identity.kind === "session" &&
      !SAFE_METHODS.has(request.method) &&
      !isOriginAllowed(request.headers.origin, request.headers.host)
    ) {
      return reply.code(403).send({ error: "This request came from another origin." });
    }
  });
}

/** A bearer beats a cookie, so an agent sending both is treated as an agent. */
function resolve(app: FastifyInstance, request: FastifyRequest): Identity | null {
  const secret = bearerFrom(request.headers.authorization);
  if (secret) {
    const token = app.tokens.resolve(secret);
    if (token) return { kind: "token", id: token.id };
  }
  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie) {
    const session = app.sessions.resolve(cookie);
    if (session) return { kind: "session", id: session.id };
  }
  return app.authMode === "open" ? { kind: "open" } : null;
}

/**
 * Fastify routes the decoded path, so `/%61pi/projects` reaches the projects
 * route while the raw target says nothing about `/api`. Both are consulted, and
 * the stricter answer wins, so an encoded path cannot pick a weaker guard.
 */
function guardOf(request: FastifyRequest): Guard {
  const byRoute = guardFor(request.routeOptions.url ?? "");
  const byTarget = guardFor(request.url);
  return byRoute === "none" ? byTarget : byRoute;
}
