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

/** The three formats an export can serve. PNG is the render itself. */
export type ExportFormat = "png" | "jpeg" | "webp";

/** The quality a lossy grant gets when it names none. */
export const DEFAULT_QUALITY = 92;

/**
 * The format named by each URL extension. `jpeg` reads back from `.jpg`
 * because MediaStore already files JPEG bytes under that extension.
 */
const FORMAT_BY_EXTENSION = new Map<string, ExportFormat>([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["webp", "webp"],
]);

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
   * here can know whether another record names the same hash. A converted
   * variant of a dropped render is equally dead, so it goes in the same sweep.
   *
   * The INSERT below can also replace a render in place, at the same version:
   * usePublishOnReady re-publishes a ready slideshow on every fresh tab, and two
   * browsers do not rasterise identical pixels. That path bypasses the sweep
   * above, since its version never drops below the stored one, so the same-slide
   * delete below clears that slide's variants too. What survives is a re-encode
   * on the next export, which is the point: a stale variant would otherwise keep
   * serving pixels the render no longer has.
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
        "DELETE FROM slideshow_render_variant WHERE slideshow_id = ? AND version < ?",
      )
      .run(slideshowId, version);
    this.db
      .prepare(
        "DELETE FROM slideshow_render_variant WHERE slideshow_id = ? AND version = ? AND idx = ?",
      )
      .run(slideshowId, version, index);
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

  /**
   * Files one slide converted to one format at one quality.
   *
   * Keyed on the format and the quality as well as the slide, so a caller that
   * exports the same version at two qualities keeps both rather than replacing
   * one with the other.
   */
  putVariant(
    slideshowId: string,
    version: number,
    index: number,
    format: ExportFormat,
    quality: number,
    variant: RenderInput,
  ): void {
    if (!MEDIA_ID.test(variant.mediaId))
      throw new HttpError(500, "Not a valid media id.");
    this.db
      .prepare(
        `INSERT INTO slideshow_render_variant
           (slideshow_id, version, idx, format, quality, media_id, width, height, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slideshow_id, version, idx, format, quality) DO UPDATE SET
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
        format,
        quality,
        variant.mediaId,
        variant.width,
        variant.height,
        variant.bytes,
        this.now(),
      );
  }

  /** Every slide's stored variant at one format and quality, in order. */
  variantsFor(
    slideshowId: string,
    version: number,
    format: ExportFormat,
    quality: number,
  ): StoredRender[] {
    return this.db
      .prepare(
        `SELECT idx, media_id, width, height, bytes FROM slideshow_render_variant
         WHERE slideshow_id = ? AND version = ? AND format = ? AND quality = ?
         ORDER BY idx`,
      )
      .all(slideshowId, version, format, quality)
      .map((row) => toRender(row as Row));
  }

  /**
   * A new token, good for `ttlMs` from now, for one format at one quality.
   *
   * The format is fixed at the mint because the tool answers with a byte count
   * and a checksum before anything is downloaded, and both describe one
   * encoding. PNG stores quality 100: nothing reads it, and it keeps the column
   * honest for a lossless format. A lossy format with no quality named falls
   * back to DEFAULT_QUALITY rather than 100, since no variant is ever filed at
   * quality 100 for jpeg or webp.
   */
  grant(
    slideshowId: string,
    version: number,
    options: { format?: ExportFormat; quality?: number; ttlMs?: number } = {},
  ): ExportGrant {
    const format = options.format ?? "png";
    const quality = format === "png" ? 100 : (options.quality ?? DEFAULT_QUALITY);
    // 32 bytes of randomness, hex, so a token is never guessable and never
    // carries a character a URL path would have to escape.
    const token = randomBytes(32).toString("hex");
    const created = this.now();
    const expiresAt = created + (options.ttlMs ?? EXPORT_TTL_MS);
    this.db
      .prepare(
        `INSERT INTO slideshow_export
           (token, slideshow_id, version, expires_at, created_at, format, quality)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(token, slideshowId, version, expiresAt, created, format, quality);
    return { token, slideshowId, version, expiresAt };
  }

  /**
   * The render or variant a public URL points at, or null.
   *
   * The extension has to agree with the grant's own format, so a jpeg token
   * cannot be walked to `01.png` for the larger original. An unknown token, an
   * expired one, an extension that disagrees and an index with no row are all
   * indistinguishable to the caller. The route turns every one into 404.
   */
  resolve(token: string, index: number, ext: string): StoredRender | null {
    const format = FORMAT_BY_EXTENSION.get(ext);
    if (format === undefined) return null;
    const row =
      format === "png"
        ? this.db
            .prepare(
              `SELECT r.idx, r.media_id, r.width, r.height, r.bytes
               FROM slideshow_export AS e
               JOIN slideshow_render AS r
                 ON r.slideshow_id = e.slideshow_id AND r.version = e.version
               WHERE e.token = ? AND e.expires_at > ? AND r.idx = ? AND e.format = 'png'`,
            )
            .get(token, this.now(), index)
        : this.db
            .prepare(
              `SELECT v.idx, v.media_id, v.width, v.height, v.bytes
               FROM slideshow_export AS e
               JOIN slideshow_render_variant AS v
                 ON v.slideshow_id = e.slideshow_id
                AND v.version = e.version
                AND v.format = e.format
                AND v.quality = e.quality
               WHERE e.token = ? AND e.expires_at > ? AND v.idx = ? AND e.format = ?`,
            )
            .get(token, this.now(), index, format);
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
