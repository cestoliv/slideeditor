import type { FastifyInstance, FastifyRequest } from "fastify";
import { isAllowedHost, isAuthorized } from "../auth.js";

export interface SecurityOptions {
  allowedHosts: readonly string[];
  token: string;
}

/** The two guards server/main.mjs:75-84 ran before anything else touched a request. */
export function registerSecurity(
  app: FastifyInstance,
  { allowedHosts, token }: SecurityOptions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isAllowedHost(request.headers.host, allowedHosts)) return;
    return reply.code(421).send({ error: "This Host header is not allowed." });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!needsToken(request)) return;
    const authorized = isAuthorized(
      {
        remoteAddress: request.socket.remoteAddress,
        authorization: request.headers.authorization,
        url: request.url,
      },
      token,
    );
    if (authorized) return;
    return reply
      .code(401)
      .header("WWW-Authenticate", "Bearer")
      .send({ error: "Send Authorization: Bearer <token>." });
  });
}

/**
 * The agent surface. The editor's own files and /media stay open to the browser.
 *
 * Fastify routes the decoded path, so `/%61pi/projects` reaches the projects
 * route while the raw target says nothing about `/api`. Reading only the raw
 * target let that request past this guard. The route the request actually
 * matched is what decides, and the raw target still counts too, so an `/api`
 * path that matches no route stays a 401 rather than becoming a 404 that tells
 * an unauthenticated caller which routes exist.
 */
function needsToken(request: FastifyRequest): boolean {
  return isGuarded(request.routeOptions.url) || isGuarded(request.url);
}

function isGuarded(target: string | undefined): boolean {
  const path = (target ?? "").split("?")[0] ?? "";
  return path.startsWith("/api/") || path === "/mcp";
}
