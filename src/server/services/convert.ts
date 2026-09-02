import sharp from "sharp";
import { HttpError } from "../errors.js";
import type { ExportFormat } from "./exports.js";

/**
 * The matte every conversion composites over.
 *
 * A render carries an alpha channel, and a background image with transparent
 * pixels reaches a feed composited against whatever the platform picks. White
 * is not configurable: one colour is one fewer thing for a caller to get wrong,
 * and it is what the two feeds this exports for show behind an image anyway.
 */
const MATTE = "#ffffff";

const EXTENSIONS: Record<ExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

const MIME_TYPES: Record<ExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface ConvertedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

/** `jpeg` files as `.jpg`, the extension MediaStore already uses for it. */
export function extensionFor(format: ExportFormat): string {
  return EXTENSIONS[format];
}

/** The Content-Type a format serves under. */
export function mimeTypeFor(format: ExportFormat): string {
  return MIME_TYPES[format];
}

/**
 * One render, re-encoded opaque.
 *
 * The work is CPU-bound and runs on libvips' own thread pool, off the event
 * loop. `flatten` is what makes the output opaque: it composites over the matte
 * and drops the alpha channel, and it changes no pixel of an already opaque
 * render. `mozjpeg` is sharp's own default for JPEG, named here so a later
 * reader knows it was chosen.
 *
 * The dimensions are read back from the converted bytes rather than copied from
 * the render row. Nothing here resizes, so the two agree today, and reading
 * them back means a change that does resize cannot report the old numbers.
 */
export async function convertRender(
  png: Buffer,
  format: "jpeg" | "webp",
  quality: number,
): Promise<ConvertedImage> {
  const image = sharp(png).flatten({ background: MATTE });
  const bytes =
    format === "webp"
      ? await image.webp({ quality }).toBuffer()
      : await image.jpeg({ quality, mozjpeg: true }).toBuffer();
  const { width, height } = await sharp(bytes).metadata();
  // A buffer sharp just wrote always has both. Nothing a caller sends can
  // produce this, so it is a 500 rather than a request to retry differently.
  if (width === undefined || height === undefined)
    throw new HttpError(500, "The converted image reports no dimensions.");
  return { bytes, width, height };
}
