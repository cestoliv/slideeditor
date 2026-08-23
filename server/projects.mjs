import { randomUUID } from "node:crypto";
import { HttpError } from "./library.mjs";

export const DEFAULT_RATIO = { w: 9, h: 16 };

export class ProjectService {
  constructor(db, events, library = null) {
    this.db = db;
    this.events = events;
    this.library = library;
  }

  list() {
    return this.db.prepare("SELECT * FROM project ORDER BY updated_at DESC").all().map((row) => {
      const summary = toSummary(row);
      const cover = this.library?.get(summary.coverItemId);
      return { ...summary, coverUrl: cover?.url || null };
    });
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
      INSERT INTO project (id, name, document, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
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

  /** Rebuilt on every write so "which slideshows use this item" stays one query. */
  reindex(projectId, document) {
    const used = new Set();
    for (const slide of document.slides || []) {
      if (slide.backgroundItemId) used.add(slide.backgroundItemId);
      for (const overlay of slide.overlays || []) {
        if (overlay.itemId) used.add(overlay.itemId);
      }
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM project_item_use WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO project_item_use (project_id, item_id) VALUES (?, ?)");
      for (const itemId of used) insert.run(projectId, itemId);
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

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
