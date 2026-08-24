import { randomUUID } from "node:crypto";
import { HttpError } from "./library.mjs";

export const DEFAULT_RATIO = { w: 9, h: 16 };
export const STATUSES = ["draft", "ready", "published"];
// Published work is done, so it stays out of the way until asked for.
export const DEFAULT_STATUS_FILTER = ["draft", "ready"];

export class ProjectService {
  constructor(db, events, library = null) {
    this.db = db;
    this.events = events;
    this.library = library;
  }

  list({ status = DEFAULT_STATUS_FILTER } = {}) {
    const wanted = normalizeStatusFilter(status);
    const placeholders = wanted.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM project WHERE status IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...wanted);
    return rows.map((row) => {
      const summary = toSummary(row);
      const cover = this.library?.get(summary.coverItemId);
      return { ...summary, coverUrl: cover?.url || null };
    });
  }

  /**
   * Status is a label on the slideshow, not part of its document, so this skips
   * the version guard and leaves the version alone. Marking something ready must
   * never make an open editor's next save conflict.
   */
  setStatus(id, status) {
    const project = this.require(id);
    if (!STATUSES.includes(status)) {
      throw new HttpError(400, `Unknown status: ${status}. Use one of ${STATUSES.join(", ")}.`);
    }
    this.db.prepare("UPDATE project SET status = ? WHERE id = ?").run(status, id);
    this.events?.broadcast({ type: "project.status", projectId: id, status });
    return { ...project, status };
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    return row ? toProject(row) : null;
  }

  require(id) {
    const project = this.get(id);
    if (!project) throw new HttpError(404, `No slideshow with id ${id}`);
    return project;
  }

  create({ name = "New Project", document = null } = {}) {
    const now = Date.now();
    const id = randomUUID();
    const body = normalizeDocument(document);
    this.db.prepare(`
      INSERT INTO project (id, name, document, version, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'draft', ?, ?)
    `).run(id, String(name || "New Project").slice(0, 200), JSON.stringify(body), now, now);
    this.reindex(id, body);
    this.events?.broadcast({ type: "project.changed", projectId: id, version: 1 });
    return this.get(id);
  }

  /**
   * Writes only when `version` matches what the caller read. A stale write gets
   * a 409 carrying the current state, so neither side clobbers the other.
   */
  save(id, { name, document, version }) {
    const current = this.require(id);
    if (Number(version) !== current.version) {
      throw new HttpError(409, "This slideshow changed since you loaded it.", {
        currentVersion: current.version,
        project: current,
      });
    }
    const body = normalizeDocument(document);
    const nextVersion = current.version + 1;
    this.db.prepare(`
      UPDATE project SET name = ?, document = ?, version = ?, updated_at = ? WHERE id = ?
    `).run(String(name ?? current.name).slice(0, 200), JSON.stringify(body), nextVersion, Date.now(), id);
    this.reindex(id, body);
    this.events?.broadcast({ type: "project.changed", projectId: id, version: nextVersion });
    return this.get(id);
  }

  remove(id) {
    this.require(id);
    this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
    this.events?.broadcast({ type: "project.removed", projectId: id });
    return { removed: id };
  }

  /**
   * Rebuilt on every write. `project_item_use` stays live so "which slideshows
   * break if I delete this" is one query. `item_use_history` accumulates.
   */
  reindex(projectId, document) {
    const placements = new Map();
    const count = (itemId) => {
      if (itemId) placements.set(itemId, (placements.get(itemId) || 0) + 1);
    };
    for (const slide of document.slides || []) {
      count(slide.backgroundItemId);
      for (const overlay of slide.overlays || []) count(overlay.itemId);
    }
    const now = Date.now();

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM project_item_use WHERE project_id = ?").run(projectId);
      const live = this.db.prepare("INSERT OR IGNORE INTO project_item_use (project_id, item_id) VALUES (?, ?)");
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

function toSummary(row) {
  const document = safeParse(row.document);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    ratio: document.ratio || { ...DEFAULT_RATIO },
    status: row.status || "draft",
    slideCount: (document.slides || []).length,
    coverItemId: document.slides?.[0]?.backgroundItemId || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProject(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status || "draft",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...normalizeDocument(safeParse(row.document)),
  };
}

export function normalizeDocument(document) {
  const source = document && typeof document === "object" ? document : {};
  const w = Number(source.ratio?.w);
  const h = Number(source.ratio?.h);
  const ratio = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : { ...DEFAULT_RATIO };
  const slides = Array.isArray(source.slides) ? source.slides : [];
  return { ratio, slides };
}

export function normalizeStatusFilter(status) {
  if (status === "all" || status === null) return [...STATUSES];
  const list = (Array.isArray(status) ? status : String(status).split(","))
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => STATUSES.includes(entry));
  if (!list.length) throw new HttpError(400, `Unknown status filter. Use one of ${STATUSES.join(", ")}, or all.`);
  return [...new Set(list)];
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
