import { z } from "zod";
import {
  libraryItemSchema,
  libraryUseSchema,
  parseProject,
  projectSummarySchema,
} from "@shared/schema/index.js";
import type {
  LibraryItem,
  LibraryKind,
  LibrarySort,
  LibraryUse,
  Project,
  ProjectSummary,
  SlideDocument,
  SlideshowStatus,
} from "@shared/schema/index.js";
import type { SaveFn } from "../features/editor/persistence.js";

/*
 * The browser's only door to the server. Every screen reads and writes through
 * here, and every answer goes through a shared schema on the way in, so a
 * screen never has to guess whether a field arrived.
 *
 * Ported from api.js, which shipped as a global on window.
 */

/**
 * The sessionStorage key api.js used, so a session opened before the rewrite
 * keeps its token. This names where the token is kept, not the token itself.
 */
const STORAGE_KEY = "slide-studio-access";
const TOKEN_QUERY_KEY = "token";

/**
 * The token this tab already holds. Exported because the module reads it once
 * at load, which no test can reach: a reload keeping its token has to be
 * provable through adoptTokenFromUrl rather than taken on trust.
 */
export function storedToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // A private window can refuse storage. An in-memory token still works.
    return null;
  }
}

let accessToken: string | null = storedToken();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  try {
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // As above: storage is a convenience across reloads, never the source.
  }
}

/**
 * Takes `?token=` off the address bar and keeps it for the session.
 *
 * The README opens the editor from another machine as
 * `http://<ip>:4173/?token=<token>`. A token left in the URL survives in the
 * history, in a bookmark, in a shared screenshot, and in the Referer of any
 * link the page follows, so it is read once and the address is rewritten.
 * Only the token goes: api.js:16 replaced the whole search string and dropped
 * every other parameter the opener had put there.
 */
export function adoptTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const presented = url.searchParams.get(TOKEN_QUERY_KEY);
  if (!presented) {
    // Nothing in the URL, so fall back to what this tab already holds. A
    // reload inside the tab must not send the reader back for a second
    // `?token=`, and the module-load read alone cannot be tested.
    accessToken ??= storedToken();
    return accessToken;
  }
  setAccessToken(presented);
  url.searchParams.delete(TOKEN_QUERY_KEY);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return presented;
}

/*
 * A slideshow that names a library item. Declared in @shared/schema, which the
 * server's own LibraryService types itself from, and re-exported here so a
 * screen can reach it through the client it already imports.
 */
export { libraryUseSchema };
export type { LibraryUse };

/*
 * The envelopes. The item and project shapes themselves live in
 * @shared/schema, which knows nothing about the routes that wrap them, so the
 * wrappers are built here out of those schemas rather than beside them.
 */
const healthSchema = z.object({ ok: z.boolean(), name: z.string() });
const libraryListSchema = z.object({
  items: z.array(libraryItemSchema),
  total: z.number(),
});
const libraryItemEnvelope = z.object({ item: libraryItemSchema });
const libraryDetailSchema = z.object({
  item: libraryItemSchema,
  usedBy: z.array(libraryUseSchema),
});
const libraryRemoveSchema = z.object({
  removed: z.string(),
  brokeSlideshows: z.array(libraryUseSchema),
});
const projectListSchema = z.object({ projects: z.array(projectSummarySchema) });
const projectRemoveSchema = z.object({ removed: z.string() });

export type Health = z.infer<typeof healthSchema>;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /**
   * The server's own copy of the slideshow, out of the 409 a stale write gets
   * (src/server/services/projects.ts:120-124). The editor reloads from this
   * rather than issuing a second GET, which is what isConflictError and
   * conflictProject in features/editor/persistence.ts read.
   */
  readonly project: Project | undefined;
  /**
   * The slideshows a library delete would break, out of its own 409
   * (src/server/services/library.ts:258-263).
   */
  readonly usedBy: readonly LibraryUse[];

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.project = conflictProject(body);
    this.usedBy = conflictUses(body);
  }
}

function conflictProject(body: unknown): Project | undefined {
  if (typeof body !== "object" || body === null || !("project" in body)) return undefined;
  try {
    return parseProject(body.project);
  } catch {
    // A 409 whose payload this client cannot read is still a 409. The editor
    // reports the failure instead of reloading from a shape it cannot trust.
    return undefined;
  }
}

function conflictUses(body: unknown): readonly LibraryUse[] {
  if (typeof body !== "object" || body === null || !("usedBy" in body)) return [];
  const parsed = z.array(libraryUseSchema).safeParse(body.usedBy);
  return parsed.success ? parsed.data : [];
}

/**
 * A request the server refused for want of a valid token
 * (src/server/plugins/security.ts:26-28). It means the server is up and this
 * browser is not welcome, which is the opposite diagnosis from a dead server
 * and wants the opposite advice.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type CallOptions = {
  method?: HttpMethod;
  /** Omit it entirely for a request that carries none, so no content type is set. */
  body?: unknown;
};

async function call(path: string, options: CallOptions = {}): Promise<unknown> {
  if (!path.startsWith("/")) {
    // The bearer rides every request, so a path that could resolve against
    // another origin never gets as far as fetch.
    throw new TypeError(`An API path has to be same-origin and absolute: ${path}`);
  }
  const hasBody = options.body !== undefined;
  const headers = new Headers();
  if (hasBody) headers.set("Content-Type", "application/json");
  if (accessToken !== null) headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = readPayload(await response.text());
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }
  return payload;
}

/** api.js:37-45. A body that is not JSON becomes the error message itself. */
function readPayload(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const reported = payload.error;
    if (typeof reported === "string" && reported) return reported;
  }
  return `Request failed with ${status}`;
}

type QueryValue = string | number | boolean | undefined;

function withQuery(path: string, entries: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** Path segments carry a server-minted id, which still gets escaped on the way out. */
function segment(id: string): string {
  return encodeURIComponent(id);
}

function projectEnvelope(payload: unknown): { project: Project } {
  const envelope = z.object({ project: z.unknown() }).parse(payload);
  return { project: parseProject(envelope.project) };
}

export type LibraryQuery = {
  kind?: LibraryKind;
  q?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
};

export type LibraryCreateInput = {
  kind: LibraryKind;
  name: string;
  description?: string;
  usage?: string;
  tags?: string;
  contentType: string;
  /** Base64, with or without the data URL prefix the server strips. */
  data: string;
  /*
   * The server measures the image itself and only falls back to these
   * (src/server/services/library.ts:186), so a caller uploading a format the
   * parser decodes can leave them out.
   */
  width?: number;
  height?: number;
};

export type LibraryPatch = Partial<{
  name: string;
  description: string;
  usage: string;
  tags: string;
  kind: LibraryKind;
}>;

export type ProjectCreateInput = {
  name?: string;
  document?: SlideDocument;
};

export type ProjectSaveInput = {
  name: string;
  document: SlideDocument;
  version: number;
  /*
   * The caption rides the version guarded PUT the way the name does, rather
   * than getting an endpoint of its own like the status. It is a change the
   * reader makes by typing, so it belongs to the same debounce, the same
   * "pending" state and the same conflict reload as every other edit.
   */
  description: string;
  hashtags: string;
};

export const api = {
  async health(): Promise<Health> {
    return healthSchema.parse(await call("/api/health"));
  },

  async listLibrary(
    query: LibraryQuery = {},
  ): Promise<{ items: LibraryItem[]; total: number }> {
    const path = withQuery("/api/library", {
      kind: query.kind,
      q: query.q,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    return libraryListSchema.parse(await call(path));
  },

  async getLibraryItem(id: string): Promise<{ item: LibraryItem; usedBy: LibraryUse[] }> {
    return libraryDetailSchema.parse(await call(`/api/library/${segment(id)}`));
  },

  async createLibraryItem(input: LibraryCreateInput): Promise<{ item: LibraryItem }> {
    return libraryItemEnvelope.parse(
      await call("/api/library", { method: "POST", body: input }),
    );
  },

  async updateLibraryItem(
    id: string,
    patch: LibraryPatch,
  ): Promise<{ item: LibraryItem }> {
    return libraryItemEnvelope.parse(
      await call(`/api/library/${segment(id)}`, { method: "PATCH", body: patch }),
    );
  },

  async deleteLibraryItem(
    id: string,
    options: { force?: boolean } = {},
  ): Promise<{ removed: string; brokeSlideshows: LibraryUse[] }> {
    // The route reads the literal "1" (src/server/routes/library.ts:57).
    const path = withQuery(`/api/library/${segment(id)}`, {
      force: options.force ? "1" : undefined,
    });
    return libraryRemoveSchema.parse(await call(path, { method: "DELETE" }));
  },

  async listProjects(status?: string): Promise<{ projects: ProjectSummary[] }> {
    // No status leaves the server on its default filter, which hides published
    // work (DEFAULT_STATUS_FILTER in @shared/schema).
    return projectListSchema.parse(await call(withQuery("/api/projects", { status })));
  },

  async createProject(input: ProjectCreateInput = {}): Promise<{ project: Project }> {
    return projectEnvelope(
      await call("/api/projects", {
        method: "POST",
        body: { name: input.name, document: input.document },
      }),
    );
  },

  async getProject(id: string): Promise<{ project: Project }> {
    return projectEnvelope(await call(`/api/projects/${segment(id)}`));
  },

  async saveProject(id: string, input: ProjectSaveInput): Promise<{ project: Project }> {
    return projectEnvelope(
      await call(`/api/projects/${segment(id)}`, { method: "PUT", body: input }),
    );
  },

  async deleteProject(id: string): Promise<{ removed: string }> {
    return projectRemoveSchema.parse(
      await call(`/api/projects/${segment(id)}`, { method: "DELETE" }),
    );
  },

  async setProjectStatus(
    id: string,
    status: SlideshowStatus,
  ): Promise<{ project: Project }> {
    return projectEnvelope(
      await call(`/api/projects/${segment(id)}/status`, {
        method: "PATCH",
        body: { status },
      }),
    );
  },
};

/**
 * putProject (app.js:341-349) as the SaveFn the editor store takes. The
 * document is the project minus the columns the server owns, so a save never
 * sends back an id, a status, or a timestamp the server is about to recompute.
 */
export const persistProject: SaveFn = async (project) => {
  const { project: saved } = await api.saveProject(project.id, {
    name: project.name,
    document: { ratio: project.ratio, slides: project.slides },
    version: project.version,
    description: project.description,
    hashtags: project.hashtags,
  });
  return saved;
};
