import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { integer, requiredText, type Row } from "../db/rows.js";
import { HttpError } from "../errors.js";

// MediaStore.put names a file for the sha256 of its bytes (services/media.ts),
// so a real mediaId is always exactly this. Enforced here, at the write, so
// every reader (the export route's app.media.read) can join it into a path
// without checking again — the same invariant routes/media.ts re-checks on
// every read because it cannot trust its own filename.
const MEDIA_ID = /^[0-9a-f]{64}$/;

/**
 * Long enough for a link that is public for the length of a scheduling call,
 * short enough that a link left in a Metricool draft stops working. The spec
 * asked for 30 to 60 minutes and this sits in the middle.
 */
export const EXPORT_TTL_MS = 45 * 60 * 1000;

/** One slide's stored PNG. `index` is 0-based, matching the slide array. */
export interface StoredRender {
  index: number;
  mediaId: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ExportGrant {
  token: string;
  slideshowId: string;
  version: number;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface RenderInput {
  mediaId: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * The two halves of an export: durable renders, and the temporary grants that
 * publish them.
 *
 * Keeping them apart is what makes revocation a row delete. The renders are
 * expensive (a browser drew them) and the grant is free, so a second export of
 * the same version costs one INSERT.
 *
 * `now` is injected so a test can move the clock rather than sleep through a
 * forty-five minute expiry.
 */
export class ExportService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  /**
   * Files one slide's PNG.
   *
   * Filing a version newer than what is stored drops the older rows in the same
   * call. A slideshow only ever exports its current version, so an older set is
   * dead the moment a newer slide arrives, and clearing it here means the count
   * check in export_slideshow can never see two versions mixed. The media files
   * stay: the store is content-addressed and shared with the library, so nothing
   * here can know whether another record names the same hash.
   */
  putRender(
    slideshowId: string,
    version: number,
    index: number,
    render: RenderInput,
  ): void {
    // A caller can never produce a bad mediaId through the public API; one
    // arriving here means something upstream is broken, not a request a
    // caller can retry differently.
    if (!MEDIA_ID.test(render.mediaId)) throw new HttpError(500, "Not a valid media id.");
    this.db
      .prepare("DELETE FROM slideshow_render WHERE slideshow_id = ? AND version < ?")
      .run(slideshowId, version);
    this.db
      .prepare(
        `INSERT INTO slideshow_render
           (slideshow_id, version, idx, media_id, width, height, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slideshow_id, version, idx) DO UPDATE SET
           media_id = excluded.media_id,
           width    = excluded.width,
           height   = excluded.height,
           bytes    = excluded.bytes,
           created_at = excluded.created_at`,
      )
      .run(
        slideshowId,
        version,
        index,
        render.mediaId,
        render.width,
        render.height,
        render.bytes,
        this.now(),
      );
  }

  rendersFor(slideshowId: string, version: number): StoredRender[] {
    return this.db
      .prepare(
        `SELECT idx, media_id, width, height, bytes FROM slideshow_render
         WHERE slideshow_id = ? AND version = ? ORDER BY idx`,
      )
      .all(slideshowId, version)
      .map((row) => toRender(row as Row));
  }

  /** A new token, good for `ttlMs` from now. */
  grant(
    slideshowId: string,
    version: number,
    ttlMs: number = EXPORT_TTL_MS,
  ): ExportGrant {
    // 32 bytes of randomness, hex, so a token is never guessable and never
    // carries a character a URL path would have to escape.
    const token = randomBytes(32).toString("hex");
    const created = this.now();
    const expiresAt = created + ttlMs;
    this.db
      .prepare(
        `INSERT INTO slideshow_export (token, slideshow_id, version, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(token, slideshowId, version, expiresAt, created);
    return { token, slideshowId, version, expiresAt };
  }

  /**
   * The render a public URL points at, or null.
   *
   * One statement, so an unknown token, an expired one and an index with no row
   * are indistinguishable to the caller. The route turns all three into 404.
   */
  resolve(token: string, index: number): StoredRender | null {
    const row = this.db
      .prepare(
        `SELECT r.idx, r.media_id, r.width, r.height, r.bytes
         FROM slideshow_export AS e
         JOIN slideshow_render AS r
           ON r.slideshow_id = e.slideshow_id AND r.version = e.version
         WHERE e.token = ? AND e.expires_at > ? AND r.idx = ?`,
      )
      .get(token, this.now(), index);
    return row === undefined ? null : toRender(row as Row);
  }

  /** Every grant for one slideshow. Returns how many were removed. */
  revoke(slideshowId: string): number {
    const result = this.db
      .prepare("DELETE FROM slideshow_export WHERE slideshow_id = ?")
      .run(slideshowId);
    return Number(result.changes);
  }
}

function toRender(row: Row): StoredRender {
  return {
    index: integer(row, "idx"),
    mediaId: requiredText(row, "media_id"),
    width: integer(row, "width"),
    height: integer(row, "height"),
    bytes: integer(row, "bytes"),
  };
}
