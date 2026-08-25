import type { FastifyInstance } from "fastify";
import { loadToken } from "../auth.js";
import { dataPaths, openDb } from "../db/open.js";
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
  }
}

export interface ServicesOptions {
  dataDir: string;
  baseUrl: () => string;
}

/**
 * Opens the data directory and hangs the services off the instance, so a route
 * reads them from `app` instead of closing over a module-level singleton.
 * Ported from createApp in server/main.mjs:55-67.
 */
export function registerServices(
  app: FastifyInstance,
  { dataDir, baseUrl }: ServicesOptions,
): void {
  const paths = dataPaths(dataDir);
  const db = openDb(paths.database);
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

  // Fastify already owns `close`, so the brief's close() is this hook instead:
  // `await app.close()` drops the subscribers and the database handle.
  app.addHook("onClose", () => {
    events.close();
    db.close();
  });
}
