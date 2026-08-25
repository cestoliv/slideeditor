import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { AuthMode } from "../auth/mode.js";
import { resolveAuthMode } from "../auth/mode.js";
import { LoginBackoff } from "../auth/backoff.js";
import { CredentialStore } from "../auth/credentials.js";
import type { Identity } from "../auth/identity.js";
import { loadToken } from "../auth/legacyToken.js";
import { SessionStore } from "../auth/sessions.js";
import { TokenStore } from "../auth/tokens.js";
import type { DataPaths } from "../db/open.js";
import { EventBus } from "../services/events.js";
import { LibraryService } from "../services/library.js";
import { MediaStore } from "../services/media.js";
import { ProjectService } from "../services/projects.js";

declare module "fastify" {
  interface FastifyInstance {
    library: LibraryService;
    projects: ProjectService;
    events: EventBus;
    media: MediaStore;
    token: string;
    baseUrl: () => string;
    credentials: CredentialStore;
    sessions: SessionStore;
    tokens: TokenStore;
    authMode: AuthMode;
    backoff: LoginBackoff;
  }
  interface FastifyRequest {
    identity: Identity | null;
  }
}

export interface ServicesOptions {
  db: DatabaseSync;
  paths: DataPaths;
  baseUrl: () => string;
  password?: string;
  bindHost?: string;
}

/**
 * Hangs the services off the instance, so a route reads them from `app`
 * instead of closing over a module-level singleton. The database and its
 * migrations are the caller's job (buildApp's `openData`), because filesystem
 * migrations are async and this constructor is not.
 * Ported from createApp in server/main.mjs:55-67.
 */
export function registerServices(
  app: FastifyInstance,
  { db, paths, baseUrl, password, bindHost }: ServicesOptions,
): void {
  const media = new MediaStore(paths.media);
  const events = new EventBus();
  const library = new LibraryService(db, media);
  const projects = new ProjectService(db, events, library);

  app.decorate("library", library);
  app.decorate("projects", projects);
  app.decorate("events", events);
  app.decorate("media", media);
  app.decorate("token", loadToken(paths.token));
  app.decorate("baseUrl", baseUrl);

  const credentials = new CredentialStore(db);
  if (password) credentials.seed(password);
  const sessions = new SessionStore(db);
  const tokens = new TokenStore(db);
  // Resolved once here rather than per request, so a public bind with no
  // password fails while buildApp is still on the stack and no socket is open.
  const authMode = resolveAuthMode({
    hasPassword: credentials.hasPassword(),
    host: bindHost ?? "127.0.0.1",
  });

  // Rows a browser will never send again. Cheap, and it keeps the table from
  // growing without bound on a server nobody restarts.
  sessions.purgeExpired();

  app.decorate("credentials", credentials);
  app.decorate("sessions", sessions);
  app.decorate("tokens", tokens);
  app.decorate("authMode", authMode);
  app.decorate("backoff", new LoginBackoff());
  app.decorateRequest("identity", null);

  // Fastify already owns `close`, so the brief's close() is this hook instead:
  // `await app.close()` drops the subscribers and the database handle.
  app.addHook("onClose", () => {
    events.close();
    db.close();
  });
}
