import { existsSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// The five methods the API table uses, so a path that exists under another one
// answers 405 rather than 404.
const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the built client and owns every miss. The single-page router holds
 * paths this server knows nothing about, so a GET that no route and no file
 * claims falls back to index.html and lets the browser route it.
 */
export async function registerClient(app: FastifyInstance): Promise<void> {
  const root = clientRoot();
  const hasClient = existsSync(join(root, "index.html"));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root,
      // A wildcard route would swallow every GET, and the fallback below needs
      // the misses to reach the not-found handler.
      wildcard: false,
      cacheControl: false,
      setHeaders(reply, filePath) {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
        // Vite fingerprints everything it writes under assets/, so only the
        // entry document has to be revalidated.
        reply.header(
          "Cache-Control",
          filePath.includes(`${sep}assets${sep}`) ? IMMUTABLE : "no-cache",
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    if (path.startsWith("/api/")) {
      // Several API paths accept one method only. The old router answered those
      // with a 405 and kept the 404 for a path it had never heard of
      // (server/api.mjs:132-138).
      if (matchesAnotherMethod(app, request.method, path)) {
        return reply.code(405).send({ error: `${request.method} is not allowed here.` });
      }
      return reply.code(404).send({ error: `No route for ${path}` });
    }
    if (hasClient && isClientRoute(request.method, path)) {
      return reply.code(200).sendFile("index.html");
    }
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
}

/**
 * A deep link the browser should resolve, such as /projects/:id. Anything with
 * a file extension asked for a file that is not there, and /media and /mcp are
 * this server's own, so none of them become the client.
 */
function isClientRoute(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path.startsWith("/media/") || path === "/mcp") return false;
  return !extname(path);
}

function matchesAnotherMethod(
  app: FastifyInstance,
  method: string,
  path: string,
): boolean {
  return ROUTE_METHODS.some(
    (candidate) =>
      candidate !== method && app.findRoute({ method: candidate, url: path }) !== null,
  );
}

/**
 * Walks up from this module's own file until it finds package.json. This
 * module runs from src/server/plugins under tsx and from
 * dist/server/server/plugins once built, at different depths from the repo
 * root, so the root is found by walking up rather than counting directories.
 */
export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directory;
}

function clientRoot(): string {
  return join(packageRoot(), "dist", "web");
}
