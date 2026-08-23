import { createHash } from "node:crypto";
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

export function extensionForType(type) {
  return TYPES.get(String(type || "").toLowerCase().split(";")[0].trim()) || null;
}

export function typeForExtension(ext) {
  return EXTENSIONS.get(ext) || "application/octet-stream";
}

export class MediaStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  path(mediaId, ext) {
    return join(this.directory, `${mediaId}.${ext}`);
  }

  /** Content addressing means the same image uploaded twice is stored once. */
  async put(bytes, ext) {
    const mediaId = createHash("sha256").update(bytes).digest("hex");
    const target = this.path(mediaId, ext);
    if (!existsSync(target)) {
      // Write then rename so a crash cannot leave a truncated file in place.
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    }
    return mediaId;
  }

  read(mediaId, ext) {
    return readFile(this.path(mediaId, ext));
  }

  exists(mediaId, ext) {
    return existsSync(this.path(mediaId, ext));
  }

  async remove(mediaId, ext) {
    try {
      await unlink(this.path(mediaId, ext));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Reads pixel dimensions from the file header. Returns null for formats this
 * does not decode (AVIF, SVG), where the caller falls back to client values.
 */
export function imageDimensions(bytes) {
  return pngSize(bytes) || gifSize(bytes) || webpSize(bytes) || jpegSize(bytes) || null;
}

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifSize(bytes) {
  if (bytes.length < 10 || bytes.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webpSize(bytes) {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Every SOF marker but the four that are not frame headers carries the size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}
