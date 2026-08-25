import type { FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_COOKIE, cookieOptions } from "../auth/cookie.js";
import { HttpError } from "../errors.js";
import { asFields, field } from "./input.js";

interface IdParams {
  id: string;
}

const WRONG_PASSWORD = "That password is not right.";

export function authRoutes(app: FastifyInstance): void {
  app.get("/api/auth/session", (request) => ({
    authenticated: request.identity !== null,
    mode: app.authMode,
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const password = String(field(asFields(request.body), "password") ?? "");
    const ip = request.ip;

    // Paid before the answer, so a caller cannot tell a slow refusal from a
    // fast one by timing the response.
    await sleep(app.backoff.delayFor(ip));

    if (!app.credentials.verify(password)) {
      app.backoff.recordFailure(ip);
      // An unset password and a wrong one answer identically, so neither
      // tells an attacker whether the server is configured.
      return reply.code(401).send({ error: WRONG_PASSWORD });
    }
    app.backoff.recordSuccess(ip);

    const secret = app.sessions.create({
      userAgent: String(request.headers["user-agent"] ?? ""),
      ip,
    });
    return reply
      .setCookie(SESSION_COOKIE, secret, cookieOptions(isSecure(request)))
      .code(204)
      .send();
  });

  app.post("/api/auth/logout", (request, reply) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (cookie) app.sessions.revoke(cookie);
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).code(204).send();
  });

  app.post("/api/auth/password", (request, reply) => {
    const body = asFields(request.body);
    const current = String(field(body, "current") ?? "");
    const next = String(field(body, "next") ?? "");
    if (!app.credentials.verify(current)) {
      return reply.code(401).send({ error: WRONG_PASSWORD });
    }
    // Matches --reset-password in cli.ts, so the UI and the recovery path can
    // never disagree about what counts as a valid password.
    if (next.length < 12) {
      throw new HttpError(400, "A password needs at least 12 characters.");
    }
    app.credentials.setPassword(next);
    // Every other session was authorised by the old password. The one on
    // this very request survives so its holder is not signed out by their
    // own change; anywhere else, there is no session to spare.
    const cookie = request.cookies[SESSION_COOKIE];
    if (cookie) app.sessions.revokeOthers(cookie);
    else app.sessions.revokeAll();
    return reply.code(204).send();
  });

  app.get("/api/auth/tokens", () => ({ tokens: app.tokens.list() }));

  app.post("/api/auth/tokens", (request) => {
    const name = String(field(asFields(request.body), "name") ?? "");
    // The only response that ever carries the secret.
    return app.tokens.create(name);
  });

  app.delete<{ Params: IdParams }>("/api/auth/tokens/:id", (request) => {
    if (!app.tokens.revoke(request.params.id)) {
      throw new HttpError(404, "No such token.");
    }
    return { removed: request.params.id };
  });
}

/** Behind Caddy this only reports true when trustProxy is on, which is the point. */
function isSecure(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
