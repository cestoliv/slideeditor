import { homedir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { ComposeError } from "../shared/compose/index.js";
import { HttpError } from "./errors.js";
import { registerMcp } from "./mcp/server.js";
import { registerClient } from "./plugins/client.js";
import { registerSecurity } from "./plugins/security.js";
import { registerServices } from "./plugins/services.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { libraryRoutes } from "./routes/library.js";
import { mediaRoutes } from "./routes/media.js";
import { projectRoutes } from "./routes/projects.js";
import { slideshowRoutes } from "./routes/slideshows.js";

export { editUrl } from "./urls.js";

export type AppOptions = {
  dataDir?: string;
  allowedHosts?: string[];
  baseUrl?: () => string;
  logger?: boolean;
};

// Matches MAX_BODY_BYTES in server/api.mjs:4. A 25MB image arrives base64, so
// the body is a third larger than the upload limit the library enforces.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

/**
 * Everything but the socket. Task 9's CLI owns the flags, the port and the
 * listen call, so this builds the same instance for a test and for the binary.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  // Never package-relative: run through npx and that directory is a throwaway
  // cache, so the library and every slideshow would vanish between runs.
  const dataDir =
    options.dataDir ||
    process.env["SLIDE_STUDIO_DATA"] ||
    join(homedir(), ".slide-studio");
  const baseUrl = options.baseUrl ?? (() => DEFAULT_BASE_URL);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerBodyParser(app);
  registerErrorHandler(app);
  registerJsonHeaders(app);

  registerServices(app, { dataDir, baseUrl });
  registerSecurity(app, {
    allowedHosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
    token: app.token,
  });

  healthRoutes(app);
  libraryRoutes(app);
  projectRoutes(app);
  slideshowRoutes(app);
  eventRoutes(app);
  mediaRoutes(app);
  // The agent surface belongs to the server, not to the entry point that built
  // it, so an embedder and the end-to-end setup get it too.
  await registerMcp(app);
  await registerClient(app);

  return app;
}

/**
 * Reads a body the way readJson did in server/api.mjs:156-180: an empty body is
 * an empty object, and the content type is not consulted, because the old
 * server read the stream whatever an agent labelled it.
 */
function registerBodyParser(app: FastifyInstance): void {
  const parse = (
    _request: unknown,
    body: string,
    done: (error: Error | null, value?: unknown) => void,
  ): void => {
    if (!body.trim()) return done(null, {});
    try {
      done(null, JSON.parse(body) as unknown);
    } catch {
      done(new HttpError(400, "The request body is not valid JSON."));
    }
  };
  // Fastify ships parsers for application/json and text/plain. Both go, so a
  // body reaches a route the same way whatever an agent labelled it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, parse);
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .send({ error: error.message, ...(error.details ?? {}) });
    }
    // The compose engine is shared with the browser, so it throws an error that
    // carries no status. The old engine threw HttpError(400, …) and agents read
    // those messages, so the status is restored here.
    if (error instanceof ComposeError)
      return reply.code(400).send({ error: error.message });
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "The request body is too large." });
    }
    if (error.code?.startsWith("FST_ERR_CTP_")) {
      return reply.code(400).send({ error: "The request body is not valid JSON." });
    }
    console.error(error);
    return reply.code(500).send({ error: "The server hit an unexpected problem." });
  });
}

/** The two headers sendJson set on every JSON reply (server/api.mjs:182-191). */
function registerJsonHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply) => {
    const type = reply.getHeader("content-type");
    if (typeof type !== "string" || !type.startsWith("application/json")) return;
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });
}
