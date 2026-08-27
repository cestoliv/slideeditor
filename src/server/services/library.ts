import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  LibraryItem,
  LibraryKind,
  LibrarySort,
  LibraryUse,
} from "../../shared/schema/index.js";
import { integer, optionalInteger, requiredText, text, type Row } from "../db/rows.js";
import { HttpError } from "../errors.js";
import { requireAccountId, type AccountService } from "./accounts.js";
import { extensionForType, imageDimensions, type MediaStore } from "./media.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Cumulative, so a deleted slideshow does not reset an item's history.
const STATS_JOIN = `
  LEFT JOIN (
    SELECT item_id,
           SUM(placements)    AS times_used,
           COUNT(*)           AS slideshow_count,
           MIN(first_used_at) AS first_used_at,
           MAX(last_used_at)  AS last_used_at
    FROM item_use_history GROUP BY item_id
  ) AS stats ON stats.item_id = item.id
`;

const ORDER_BY: Record<LibrarySort, string> = {
  recent: "item.updated_at DESC",
  // NULL means never used, which is exactly what a varying agent wants first.
  "least-used":
    "COALESCE(stats.times_used, 0) ASC, COALESCE(stats.last_used_at, 0) ASC, item.updated_at DESC",
  "most-used": "COALESCE(stats.times_used, 0) DESC, item.updated_at DESC",
};

/** Query string values, so every field is what the URL carried and nothing more. */
export interface LibraryListOptions {
  kind?: unknown;
  query?: unknown;
  limit?: unknown;
  offset?: unknown;
  sort?: unknown;
  accountId?: unknown;
}

export interface LibraryListResult {
  items: LibraryItem[];
  total: number;
}

/**
 * What arrives on the wire. Every field but `bytes` is `unknown`, because the
 * router hands a JSON body over untouched and this is where it gets checked:
 * a narrower parameter would claim a check that happens here, not there.
 */
export interface LibraryCreateInput {
  kind: unknown;
  name: unknown;
  description?: unknown;
  usage?: unknown;
  tags?: unknown;
  contentType: unknown;
  bytes: Buffer;
  width?: unknown;
  height?: unknown;
  accountId: unknown;
}

export type LibraryPatch = Partial<{
  name: unknown;
  description: unknown;
  usage: unknown;
  tags: unknown;
  kind: unknown;
}>;

/** A slideshow that would break if the item went away. Declared in @shared/schema. */
export type { LibraryUse };

export interface LibraryRemoveResult {
  removed: string;
  brokeSlideshows: LibraryUse[];
}

export class LibraryService {
  private readonly db: DatabaseSync;
  private readonly media: MediaStore;
  private readonly accounts: AccountService | null;

  constructor(
    db: DatabaseSync,
    media: MediaStore,
    accounts: AccountService | null = null,
  ) {
    this.db = db;
    this.media = media;
    this.accounts = accounts;
  }

  list({
    kind = null,
    query = "",
    limit = 50,
    offset = 0,
    sort = "recent",
    accountId = null,
  }: LibraryListOptions = {}): LibraryListResult {
    const size = clampInteger(limit, 1, 200, 50);
    const skip = clampInteger(offset, 0, 100000, 0);
    const wanted = toKindFilter(kind);
    const order: LibrarySort = isSort(sort) ? sort : "recent";
    // `null`/omitted means "no filter"; any string — including "", which no
    // account ever has as an id — is an explicit filter that must narrow the
    // result, never widen it back to every account's rows.
    const account = typeof accountId === "string" ? accountId : null;

    const term = String(query || "").trim();
    if (!term) {
      const clauses = [
        ...(wanted ? ["item.kind = ?"] : []),
        ...(account !== null ? ["item.account_id = ?"] : []),
      ];
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const filters = [
        ...(wanted ? [wanted] : []),
        ...(account !== null ? [account] : []),
      ];
      const rows = this.db
        .prepare(
          `
        SELECT item.*, stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
        FROM library_item AS item ${STATS_JOIN} ${where}
        ORDER BY ${ORDER_BY[order]} LIMIT ? OFFSET ?
      `,
        )
        .all(...filters, size, skip);
      return { items: rows.map(toItem), total: this.count(wanted, account) };
    }

    // FTS5 treats bare punctuation as syntax, so each word becomes a prefix term.
    const match = term
      .split(/\s+/)
      .map((word) => word.replace(/["*]/g, ""))
      .filter(Boolean)
      .map((word) => `"${word}"*`)
      .join(" ");
    if (!match) return { items: [], total: 0 };

    const searchClauses = [
      ...(wanted ? ["item.kind = ?"] : []),
      ...(account !== null ? ["item.account_id = ?"] : []),
    ];
    const where = searchClauses.length ? `AND ${searchClauses.join(" AND ")}` : "";
    const filters = [
      match,
      ...(wanted ? [wanted] : []),
      ...(account !== null ? [account] : []),
    ];
    // Relevance wins by default; an explicit sort overrides it.
    const ordering = order === "recent" ? "rank" : ORDER_BY[order];
    const rows = this.db
      .prepare(
        `
      SELECT item.*, bm25(library_search) AS rank,
             stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
      FROM library_search
      JOIN library_item AS item ON item.rowid = library_search.rowid
      ${STATS_JOIN}
      WHERE library_search MATCH ? ${where}
      ORDER BY ${ordering} LIMIT ? OFFSET ?
    `,
      )
      .all(...filters, size, skip);
    return { items: rows.map(toItem), total: rows.length };
  }

  count(kind: LibraryKind | null = null, accountId: string | null = null): number {
    const clauses = [
      ...(kind ? ["kind = ?"] : []),
      ...(accountId !== null ? ["account_id = ?"] : []),
    ];
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const filters = [...(kind ? [kind] : []), ...(accountId !== null ? [accountId] : [])];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM library_item ${where}`)
      .get(...filters);
    return row ? integer(row, "total") : 0;
  }

  get(id: string): LibraryItem | null {
    const row = this.db
      .prepare(
        `
      SELECT item.*, stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
      FROM library_item AS item ${STATS_JOIN} WHERE item.id = ?
    `,
      )
      .get(id);
    return row ? toItem(row) : null;
  }

  require(id: string, expectedKind: LibraryKind | null = null): LibraryItem {
    const item = this.get(id);
    if (!item) throw new HttpError(404, `No library item with id ${id}`);
    if (expectedKind && item.kind !== expectedKind) {
      throw new HttpError(
        400,
        `Library item ${id} is ${article(item.kind)}, expected ${article(expectedKind)}.`,
      );
    }
    return item;
  }

  async create({
    kind,
    name,
    description = "",
    usage = "",
    tags = "",
    contentType,
    bytes,
    width,
    height,
    accountId,
  }: LibraryCreateInput): Promise<LibraryItem> {
    if (!isKind(kind)) throw new HttpError(400, `Unknown kind: ${kind}`);
    const account = requireAccountId(this.accounts, accountId, "A library item");
    if (!bytes?.length) throw new HttpError(400, "The upload carried no image data.");
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new HttpError(413, "Images must be 25MB or smaller.");
    const ext = extensionForType(contentType);
    if (!ext) throw new HttpError(415, `Unsupported image type: ${contentType}`);

    // Trust the file's own header first. Client values only fill in for the
    // formats the parser does not decode.
    const measured = imageDimensions(bytes) || {
      width: Number(width),
      height: Number(height),
    };
    if (
      !Number.isFinite(measured.width) ||
      !Number.isFinite(measured.height) ||
      measured.width <= 0 ||
      measured.height <= 0
    ) {
      throw new HttpError(400, "Could not determine the image dimensions.");
    }

    const mediaId = await this.media.put(bytes, ext);
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        kind,
        cleanText(name) || "Untitled",
        cleanText(description),
        cleanText(usage),
        cleanTags(tags),
        mediaId,
        ext,
        Math.round(measured.width),
        Math.round(measured.height),
        account,
        now,
        now,
      );
    return this.require(id);
  }

  update(id: string, patch: LibraryPatch): LibraryItem {
    const existing = this.require(id);
    const next = {
      name:
        patch.name === undefined ? existing.name : cleanText(patch.name) || existing.name,
      description:
        patch.description === undefined
          ? existing.description
          : cleanText(patch.description),
      usage: patch.usage === undefined ? existing.usage : cleanText(patch.usage),
      tags: patch.tags === undefined ? existing.tags.join(", ") : cleanTags(patch.tags),
      kind: patch.kind === undefined ? existing.kind : patch.kind,
    };
    if (!isKind(next.kind)) throw new HttpError(400, `Unknown kind: ${next.kind}`);
    this.db
      .prepare(
        `
      UPDATE library_item SET name = ?, description = ?, usage = ?, tags = ?, kind = ?, updated_at = ? WHERE id = ?
    `,
      )
      .run(next.name, next.description, next.usage, next.tags, next.kind, Date.now(), id);
    return this.require(id);
  }

  usedBy(id: string): LibraryUse[] {
    const rows = this.db
      .prepare(
        `
      SELECT project.id, project.name FROM project_item_use
      JOIN project ON project.id = project_item_use.project_id
      WHERE project_item_use.item_id = ? ORDER BY project.name
    `,
      )
      .all(id);
    return rows.map((row) => ({ id: text(row, "id"), name: text(row, "name") }));
  }

  async remove(
    id: string,
    { force = false }: { force?: boolean } = {},
  ): Promise<LibraryRemoveResult> {
    const item = this.require(id);
    const users = this.usedBy(id);
    if (users.length && !force) {
      throw new HttpError(
        409,
        `${item.name} is used by ${users.length} slideshow${users.length === 1 ? "" : "s"}.`,
        {
          usedBy: users,
        },
      );
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM project_item_use WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM library_item WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Other items may share the bytes, so only drop the file when nothing points at it.
    const shared = this.db
      .prepare("SELECT COUNT(*) AS total FROM library_item WHERE media_id = ?")
      .get(item.mediaId);
    if (!shared || !integer(shared, "total"))
      await this.media.remove(item.mediaId, item.ext);
    return { removed: id, brokeSlideshows: users };
  }
}

function toItem(row: Row): LibraryItem {
  const mediaId = text(row, "media_id");
  const ext = text(row, "ext");
  const tags = text(row, "tags");
  return {
    id: text(row, "id"),
    kind: text(row, "kind") === "asset" ? "asset" : "background",
    name: text(row, "name"),
    description: text(row, "description"),
    usage: text(row, "usage"),
    tags: tags
      ? tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [],
    accountId: requiredText(row, "account_id"),
    mediaId,
    ext,
    url: `/media/${mediaId}.${ext}`,
    width: integer(row, "width"),
    height: integer(row, "height"),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
    stats: {
      timesUsed: optionalInteger(row, "times_used") || 0,
      slideshowCount: optionalInteger(row, "slideshow_count") || 0,
      firstUsedAt: optionalInteger(row, "first_used_at") || null,
      lastUsedAt: optionalInteger(row, "last_used_at") || null,
    },
  };
}

/** The two kinds a library item can be. Replaces the KINDS set, which could not narrow. */
function isKind(value: unknown): value is LibraryKind {
  return value === "background" || value === "asset";
}

/** The three orders list understands. Replaces the SORTS set, for the same reason. */
function isSort(value: unknown): value is LibrarySort {
  return value === "recent" || value === "least-used" || value === "most-used";
}

/** An absent filter lists everything, and anything that is not a kind is the 400 it always was. */
function toKindFilter(value: unknown): LibraryKind | null {
  if (!value) return null;
  if (!isKind(value)) throw new HttpError(400, `Unknown kind: ${value}`);
  return value;
}

function article(kind: LibraryKind): string {
  return kind === "asset" ? "an asset" : "a background";
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .slice(0, 4000);
}

function cleanTags(value: unknown): string {
  // Array.isArray narrows unknown to any[], which this file does without.
  const list: unknown[] = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [
    ...new Set(list.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)),
  ].join(", ");
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
