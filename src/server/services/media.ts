import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
  ["image/avif", "avif"],
]);

const EXTENSIONS = new Map([...TYPES].map(([type, ext]) => [ext, type]));

// Google fonts are self-hosted through this same content-addressed store, at
// /media/<hash>.woff2. They are never a valid image upload, so this stays out
// of TYPES/extensionForType (which gate what the library accepts) — only
// typeForExtension needs it, to send the right Content-Type back.
const FONT_EXTENSIONS = new Map([
  ["woff2", "font/woff2"],
  ["woff", "font/woff"],
]);

export interface ImageSize {
  width: number;
  height: number;
}

export function extensionForType(type: unknown): string | null {
  return (
    TYPES.get(
      String(type || "")
        .toLowerCase()
        .split(";")[0]
        ?.trim() ?? "",
    ) ?? null
  );
}

export function typeForExtension(ext: string): string {
  return EXTENSIONS.get(ext) ?? FONT_EXTENSIONS.get(ext) ?? "application/octet-stream";
}

export class MediaStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  pathFor(mediaId: string, ext: string): string {
    return join(this.directory, `${mediaId}.${ext}`);
  }

  /** Content addressing means the same image uploaded twice is stored once. */
  async put(bytes: Buffer, ext: string): Promise<string> {
    const mediaId = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(mediaId, ext);
    if (existsSync(target)) return mediaId;

    // A name no other call can hold. The old name was `<target>.<pid>.tmp`,
    // which two uploads of the same image in one process share: they wrote over
    // each other, and one renamed a half-written file into place under a hash
    // asserting it was whole. Nothing writes to a shared path any more, so that
    // interleave has no way to happen rather than a smaller chance of it.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      // Write then rename, so a crash cannot leave a truncated file in place
      // and a reader never opens a partial one. Rename is atomic, so `target`
      // is either absent or complete at every instant.
      await writeFile(temporary, bytes);
      // The name is the hash of the bytes, so a target that appeared while this
      // call was writing already holds exactly what this call would write.
      // Replacing it would gain nothing, and on Windows it fails outright while
      // a reader has the file open.
      if (!existsSync(target)) await rename(temporary, target);
    } finally {
      // After a rename there is nothing here to remove, which is why this
      // forgives ENOENT rather than checking first.
      await remove(temporary);
    }
    return mediaId;
  }

  read(mediaId: string, ext: string): Promise<Buffer> {
    return readFile(this.pathFor(mediaId, ext));
  }

  exists(mediaId: string, ext: string): boolean {
    return existsSync(this.pathFor(mediaId, ext));
  }

  async remove(mediaId: string, ext: string): Promise<void> {
    await remove(this.pathFor(mediaId, ext));
  }
}

/** Unlinks a path that may already be gone, which is not a failure here. */
async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Reads pixel dimensions from the file header. Returns null for formats this
 * does not decode (AVIF, SVG), where the caller falls back to client values.
 */
export function imageDimensions(bytes: Buffer): ImageSize | null {
  return pngSize(bytes) || gifSize(bytes) || webpSize(bytes) || jpegSize(bytes) || null;
}

function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 10 || bytes.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null;
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + (byte(bytes, 24) | (byte(bytes, 25) << 8) | (byte(bytes, 26) << 16)),
      height: 1 + (byte(bytes, 27) | (byte(bytes, 28) << 8) | (byte(bytes, 29) << 16)),
    };
  }
  if (chunk === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpegSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 4 || byte(bytes, 0) !== 0xff || byte(bytes, 1) !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (byte(bytes, offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = byte(bytes, offset + 1);
    // Every SOF marker but the four that are not frame headers carries the size.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame)
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

// Buffer indexing is `number | undefined` under noUncheckedIndexedAccess, and
// every read below already sits behind a length check.
function byte(bytes: Buffer, index: number): number {
  return bytes[index] ?? 0;
}
