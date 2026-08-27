import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_RATIO,
  DEFAULT_STATUS_FILTER,
  normalizeDescription,
  normalizeHashtags,
  SLIDESHOW_STATUSES,
} from "../../shared/schema/index.js";
import type {
  ProjectSummary,
  Ratio,
  SlideshowStatus,
} from "../../shared/schema/index.js";
import { validateDocumentAccountScope } from "../../shared/compose/index.js";
import { integer, requiredText, text, type Row } from "../db/rows.js";
import { HttpError } from "../errors.js";
import { requireAccountId, type AccountService } from "./accounts.js";
import type { EventBus } from "./events.js";
import type { LibraryService } from "./library.js";

/**
 * A document as it sits in the database. The old server stored the client's
 * JSON untouched apart from the ratio (server/projects.mjs:160-166), so the
 * slides stay opaque here: a field this rewrite does not model must survive a
 * save round trip rather than being dropped by a schema that never saw it.
 */
export interface StoredDocument {
  ratio: Ratio;
  slides: unknown[];
}

/** What `get` and `save` hand back: the row's own columns plus its document. */
export type StoredProject = {
  id: string;
  name: string;
  version: number;
  status: SlideshowStatus;
  description: string;
  hashtags: string;
  accountId: string;
  createdAt: number;
  updatedAt: number;
} & StoredDocument;

export interface ProjectListOptions {
  status?: string | string[] | null;
  accountId?: string | null;
}

export interface ProjectCreateInput {
  name?: unknown;
  document?: unknown;
  description?: unknown;
  hashtags?: unknown;
  accountId: unknown;
}

/**
 * The caption fields are optional, and absent is not the same as empty: a
 * caller that says nothing about them leaves what is already stored alone.
 * Every editor before this feature sends a save carrying neither, and one of
 * those must not wipe a caption an agent wrote a moment earlier.
 */
export interface ProjectSaveInput {
  name?: unknown;
  document: unknown;
  version: unknown;
  description?: unknown;
  hashtags?: unknown;
}

export class ProjectService {
  private readonly db: DatabaseSync;
  private readonly events: EventBus | null;
  private readonly library: LibraryService | null;
  private readonly accounts: AccountService | null;

  constructor(
    db: DatabaseSync,
    events: EventBus | null,
    library: LibraryService | null = null,
    accounts: AccountService | null = null,
  ) {
    this.db = db;
    this.events = events;
    this.library = library;
    this.accounts = accounts;
  }

  list({
    status = [...DEFAULT_STATUS_FILTER],
    accountId = null,
  }: ProjectListOptions = {}): ProjectSummary[] {
    const wanted = normalizeStatusFilter(status);
    const placeholders = wanted.map(() => "?").join(", ");
    // `null`/omitted means "no filter"; any string — including "", which no
    // account ever has as an id — is an explicit filter that must narrow the
    // result, never widen it back to every account's rows.
    const account = typeof accountId === "string" ? accountId : null;
    const accountClause = account !== null ? " AND account_id = ?" : "";
    const parameters = account !== null ? [...wanted, account] : wanted;
    const rows = this.db
      .prepare(
        `SELECT * FROM project WHERE status IN (${placeholders})${accountClause} ORDER BY updated_at DESC`,
      )
      .all(...parameters);
    return rows.map((row) => {
      const summary = toSummary(row);
      const cover = summary.coverItemId ? this.library?.get(summary.coverItemId) : null;
      return { ...summary, coverUrl: cover?.url || null };
    });
  }

  /**
   * Status is a label on the slideshow, not part of its document, so this skips
   * the version guard and leaves the version alone. Marking something ready must
   * never make an open editor's next save conflict.
   */
  setStatus(id: string, status: unknown): StoredProject {
    const project = this.require(id);
    const next = toStatus(status);
    if (!next) {
      throw new HttpError(
        400,
        `Unknown status: ${status}. Use one of ${SLIDESHOW_STATUSES.join(", ")}.`,
      );
    }
    this.db.prepare("UPDATE project SET status = ? WHERE id = ?").run(next, id);
    this.events?.broadcast({ type: "project.status", projectId: id, status: next });
    return { ...project, status: next };
  }

  get(id: string): StoredProject | null {
    const row = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    return row ? toProject(row) : null;
  }

  require(id: string): StoredProject {
    const project = this.get(id);
    if (!project) throw new HttpError(404, `No slideshow with id ${id}`);
    return project;
  }

  create({
    name = "New Project",
    document = null,
    description,
    hashtags,
    accountId,
  }: ProjectCreateInput): StoredProject {
    const account = requireAccountId(this.accounts, accountId, "A slideshow");
    const now = Date.now();
    const id = randomUUID();
    // Seeds the ratio from the account's default when the caller's document
    // carries none of its own — a bare {} from a fresh editor create, or an
    // absent field entirely. A document that already names a ratio keeps it.
    const body = normalizeDocument(document, this.accounts?.get(account)?.defaults.ratio);
    this.assertOwnScope(body, account);
    this.db
      .prepare(
        `
      INSERT INTO project (id, name, document, version, status, description, hashtags, account_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        String(name || "New Project").slice(0, 200),
        JSON.stringify(body),
        normalizeDescription(description),
        normalizeHashtags(hashtags),
        account,
        now,
        now,
      );
    this.reindex(id, body);
    this.events?.broadcast({ type: "project.changed", projectId: id, version: 1 });
    return this.require(id);
  }

  /**
   * Writes only when `version` matches what the caller read. A stale write gets
   * a 409 carrying the current state, so neither side clobbers the other.
   */
  save(
    id: string,
    { name, document, version, description, hashtags }: ProjectSaveInput,
  ): StoredProject {
    const current = this.require(id);
    if (Number(version) !== current.version) {
      throw new HttpError(409, "This slideshow changed since you loaded it.", {
        currentVersion: current.version,
        project: current,
      });
    }
    // Falls back to the slideshow's OWN current ratio, not the account's
    // default — the account default only seeds a slideshow once, at create()
    // (see there), which is the snapshot rule this feature is built on. A
    // PUT whose body omits ratio used to fall through to the account's
    // (possibly since-changed) default, silently reshaping e.g. a 1:1
    // slideshow in a 9:16-default account back to 9:16 on any save that did
    // not carry its own ratio. Falling back to current.ratio matches the
    // sibling route (routes/slideshows.ts), which already gets this right.
    const body = normalizeDocument(document, current.ratio);
    this.assertOwnScope(body, current.accountId);
    const nextVersion = current.version + 1;
    this.db
      .prepare(
        `
      UPDATE project SET name = ?, document = ?, version = ?, description = ?, hashtags = ?, updated_at = ? WHERE id = ?
    `,
      )
      .run(
        String(name ?? current.name).slice(0, 200),
        JSON.stringify(body),
        nextVersion,
        description === undefined
          ? current.description
          : normalizeDescription(description),
        hashtags === undefined ? current.hashtags : normalizeHashtags(hashtags),
        Date.now(),
        id,
      );
    this.reindex(id, body);
    this.events?.broadcast({
      type: "project.changed",
      projectId: id,
      version: nextVersion,
    });
    return this.require(id);
  }

  remove(id: string): { removed: string } {
    this.require(id);
    this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
    this.events?.broadcast({ type: "project.removed", projectId: id });
    return { removed: id };
  }

  /**
   * `/api/projects` accepts a raw document rather than the agent's Composition
   * shorthand, so this is the cross-account guard for that write path — the
   * same rule validateComposition enforces on the shorthand routes, run over
   * the same item ids reindex() extracts below. Skipped when there is no
   * library to check against (e.g. some unit tests construct the service
   * without one), matching how the rest of this class treats a null library.
   *
   * `lookupItem` is memoized per call: a background reused across many slides
   * (the common case) named `library.get()` — a stats-joined query — once per
   * occurrence rather than once per distinct id, on every debounced save.
   */
  private assertOwnScope(document: StoredDocument, accountId: string): void {
    if (!this.library) return;
    const library = this.library;
    const cache = new Map<string, ReturnType<LibraryService["get"]>>();
    validateDocumentAccountScope(document.slides, {
      accountId,
      lookupItem: (id) => {
        if (!cache.has(id)) cache.set(id, library.get(id));
        return cache.get(id) ?? null;
      },
    });
  }

  /**
   * Rebuilt on every write. `project_item_use` stays live so "which slideshows
   * break if I delete this" is one query. `item_use_history` accumulates.
   */
  reindex(projectId: string, document: StoredDocument): void {
    const placements = new Map<string, number>();
    const count = (itemId: unknown): void => {
      if (typeof itemId === "string" && itemId)
        placements.set(itemId, (placements.get(itemId) || 0) + 1);
    };
    for (const entry of document.slides) {
      const slide = asRecord(entry);
      if (!slide) continue;
      count(slide["backgroundItemId"]);
      const overlays = slide["overlays"];
      if (!Array.isArray(overlays)) continue;
      for (const candidate of overlays) {
        const overlay = asRecord(candidate);
        if (overlay) count(overlay["itemId"]);
      }
    }
    const now = Date.now();

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM project_item_use WHERE project_id = ?").run(projectId);
      const live = this.db.prepare(
        "INSERT OR IGNORE INTO project_item_use (project_id, item_id) VALUES (?, ?)",
      );
      const history = this.db.prepare(`
        INSERT INTO item_use_history (item_id, project_id, placements, first_used_at, last_used_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (item_id, project_id) DO UPDATE SET placements = excluded.placements, last_used_at = excluded.last_used_at
      `);
      for (const [itemId, total] of placements) {
        live.run(projectId, itemId);
        history.run(itemId, projectId, total, now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Everything but coverUrl, which list() appends afterwards by looking the cover
 * item up in the library (server/projects.mjs:23-25). Keeping the two steps
 * apart keeps coverUrl last in the serialised object, where it has always been.
 */
function toSummary(row: Row): Omit<ProjectSummary, "coverUrl"> {
  const document = asRecord(safeParse(text(row, "document"))) ?? {};
  const slides = Array.isArray(document["slides"]) ? document["slides"] : [];
  const first = asRecord(slides[0]);
  const coverItemId = first?.["backgroundItemId"];
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    version: integer(row, "version"),
    ratio: readRatio(document["ratio"]),
    status: readStatus(row),
    description: text(row, "description"),
    hashtags: text(row, "hashtags"),
    accountId: requiredText(row, "account_id"),
    slideCount: slides.length,
    coverItemId: typeof coverItemId === "string" && coverItemId ? coverItemId : null,
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

function toProject(row: Row): StoredProject {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    version: integer(row, "version"),
    status: readStatus(row),
    description: text(row, "description"),
    hashtags: text(row, "hashtags"),
    accountId: requiredText(row, "account_id"),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
    ...normalizeDocument(safeParse(text(row, "document"))),
  };
}

export function normalizeDocument(
  document: unknown,
  fallbackRatio?: Ratio,
): StoredDocument {
  const source = asRecord(document) ?? {};
  const slides = Array.isArray(source["slides"]) ? source["slides"] : [];
  return {
    ratio: readRatio(source["ratio"], fallbackRatio),
    // A slide that is not a plain object (a bare string, a number, null) is
    // dropped rather than stored — the same "not an object, skip it"
    // tolerance reindex() already applies when it walks a document's slides.
    // Storing one verbatim used to let a raw POST/PUT (the /api/projects
    // route forwards body.document with no composition validation, unlike
    // routes/slideshows.ts) write a document that fonts.remove()'s
    // json_each-based in-use query could not walk — see fonts.ts.
    slides: slides.filter((entry) => asRecord(entry) !== null),
  };
}

export function normalizeStatusFilter(status: unknown): string[] {
  if (status === "all" || status === null) return [...SLIDESHOW_STATUSES];
  const list = (Array.isArray(status) ? status : String(status).split(","))
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry): entry is SlideshowStatus => toStatus(entry) !== null);
  if (!list.length) {
    throw new HttpError(
      400,
      `Unknown status filter. Use one of ${SLIDESHOW_STATUSES.join(", ")}, or all.`,
    );
  }
  return [...new Set(list)];
}

/** The status column, or "draft" for a row written before the status migration. */
function readStatus(row: Row): SlideshowStatus {
  return toStatus(text(row, "status")) ?? "draft";
}

function toStatus(value: unknown): SlideshowStatus | null {
  for (const status of SLIDESHOW_STATUSES) {
    if (status === value) return status;
  }
  return null;
}

function readRatio(value: unknown, fallback: Ratio = DEFAULT_RATIO): Ratio {
  const source = asRecord(value);
  const w = Number(source?.["w"]);
  const h = Number(source?.["h"]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? { w, h }
    : { ...fallback };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
