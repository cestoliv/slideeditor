import { randomUUID } from "node:crypto";
import { extensionForType, imageDimensions } from "./media.mjs";

const KINDS = new Set(["background", "asset"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SORTS = new Set(["recent", "least-used", "most-used"]);

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

const ORDER_BY = {
  "recent": "item.updated_at DESC",
  // NULL means never used, which is exactly what a varying agent wants first.
  "least-used": "COALESCE(stats.times_used, 0) ASC, COALESCE(stats.last_used_at, 0) ASC, item.updated_at DESC",
  "most-used": "COALESCE(stats.times_used, 0) DESC, item.updated_at DESC",
};

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class LibraryService {
  constructor(db, media) {
    this.db = db;
    this.media = media;
  }

  list({ kind = null, query = "", limit = 50, offset = 0, sort = "recent" } = {}) {
    const size = clampInteger(limit, 1, 200, 50);
    const skip = clampInteger(offset, 0, 100000, 0);
    if (kind && !KINDS.has(kind)) throw new HttpError(400, `Unknown kind: ${kind}`);
    const order = SORTS.has(sort) ? sort : "recent";

    const term = String(query || "").trim();
    if (!term) {
      const where = kind ? "WHERE item.kind = ?" : "";
      const parameters = kind ? [kind, size, skip] : [size, skip];
      const rows = this.db.prepare(`
        SELECT item.*, stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
        FROM library_item AS item ${STATS_JOIN} ${where}
        ORDER BY ${ORDER_BY[order]} LIMIT ? OFFSET ?
      `).all(...parameters);
      return { items: rows.map(toItem), total: this.count(kind) };
    }

    // FTS5 treats bare punctuation as syntax, so each word becomes a prefix term.
    const match = term
      .split(/\s+/)
      .map((word) => word.replace(/["*]/g, ""))
      .filter(Boolean)
      .map((word) => `"${word}"*`)
      .join(" ");
    if (!match) return { items: [], total: 0 };

    const where = kind ? "AND item.kind = ?" : "";
    const parameters = kind ? [match, kind, size, skip] : [match, size, skip];
    // Relevance wins by default; an explicit sort overrides it.
    const ordering = order === "recent" ? "rank" : ORDER_BY[order];
    const rows = this.db.prepare(`
      SELECT item.*, bm25(library_search) AS rank,
             stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
      FROM library_search
      JOIN library_item AS item ON item.rowid = library_search.rowid
      ${STATS_JOIN}
      WHERE library_search MATCH ? ${where}
      ORDER BY ${ordering} LIMIT ? OFFSET ?
    `).all(...parameters);
    return { items: rows.map(toItem), total: rows.length };
  }

  count(kind = null) {
    const row = kind
      ? this.db.prepare("SELECT COUNT(*) AS total FROM library_item WHERE kind = ?").get(kind)
      : this.db.prepare("SELECT COUNT(*) AS total FROM library_item").get();
    return row.total;
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT item.*, stats.times_used, stats.slideshow_count, stats.first_used_at, stats.last_used_at
      FROM library_item AS item ${STATS_JOIN} WHERE item.id = ?
    `).get(id);
    return row ? toItem(row) : null;
  }

  require(id, expectedKind = null) {
    const item = this.get(id);
    if (!item) throw new HttpError(404, `No library item with id ${id}`);
    if (expectedKind && item.kind !== expectedKind) {
      throw new HttpError(400, `Library item ${id} is ${article(item.kind)}, expected ${article(expectedKind)}.`);
    }
    return item;
  }

  async create({ kind, name, description = "", usage = "", tags = "", contentType, bytes, width, height }) {
    if (!KINDS.has(kind)) throw new HttpError(400, `Unknown kind: ${kind}`);
    if (!bytes?.length) throw new HttpError(400, "The upload carried no image data.");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "Images must be 25MB or smaller.");
    const ext = extensionForType(contentType);
    if (!ext) throw new HttpError(415, `Unsupported image type: ${contentType}`);

    // Trust the file's own header first. Client values only fill in for the
    // formats the parser does not decode.
    const measured = imageDimensions(bytes) || { width: Number(width), height: Number(height) };
    if (!Number.isFinite(measured.width) || !Number.isFinite(measured.height) || measured.width <= 0 || measured.height <= 0) {
      throw new HttpError(400, "Could not determine the image dimensions.");
    }

    const mediaId = await this.media.put(bytes, ext);
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, kind, cleanText(name) || "Untitled", cleanText(description), cleanText(usage), cleanTags(tags),
      mediaId, ext, Math.round(measured.width), Math.round(measured.height), now, now);
    return this.get(id);
  }

  update(id, patch) {
    const existing = this.require(id);
    const next = {
      name: patch.name === undefined ? existing.name : cleanText(patch.name) || existing.name,
      description: patch.description === undefined ? existing.description : cleanText(patch.description),
      usage: patch.usage === undefined ? existing.usage : cleanText(patch.usage),
      tags: patch.tags === undefined ? existing.tags.join(", ") : cleanTags(patch.tags),
      kind: patch.kind === undefined ? existing.kind : patch.kind,
    };
    if (!KINDS.has(next.kind)) throw new HttpError(400, `Unknown kind: ${next.kind}`);
    this.db.prepare(`
      UPDATE library_item SET name = ?, description = ?, usage = ?, tags = ?, kind = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.description, next.usage, next.tags, next.kind, Date.now(), id);
    return this.get(id);
  }

  usedBy(id) {
    return this.db.prepare(`
      SELECT project.id, project.name FROM project_item_use
      JOIN project ON project.id = project_item_use.project_id
      WHERE project_item_use.item_id = ? ORDER BY project.name
    `).all(id);
  }

  async remove(id, { force = false } = {}) {
    const item = this.require(id);
    const users = this.usedBy(id);
    if (users.length && !force) {
      throw new HttpError(409, `${item.name} is used by ${users.length} slideshow${users.length === 1 ? "" : "s"}.`, { usedBy: users });
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
    const shared = this.db.prepare("SELECT COUNT(*) AS total FROM library_item WHERE media_id = ?").get(item.mediaId);
    if (!shared.total) await this.media.remove(item.mediaId, item.ext);
    return { removed: id, brokeSlideshows: users };
  }
}

function toItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    usage: row.usage,
    tags: row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    mediaId: row.media_id,
    ext: row.ext,
    url: `/media/${row.media_id}.${row.ext}`,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: {
      timesUsed: row.times_used || 0,
      slideshowCount: row.slideshow_count || 0,
      firstUsedAt: row.first_used_at || null,
      lastUsedAt: row.last_used_at || null,
    },
  };
}

function article(kind) {
  return kind === "asset" ? "an asset" : "a background";
}

function cleanText(value) {
  return String(value ?? "").trim().slice(0, 4000);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].join(", ");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
