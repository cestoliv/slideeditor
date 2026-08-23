import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp } from "../server/main.mjs";

const CRC = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A real PNG, so the header parser has something honest to read. */
export function solidPng(width, height, colour = [128, 128, 128]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = colour[0];
      raw[row + 2 + x * 3] = colour[1];
      raw[row + 3 + x * 3] = colour[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A throwaway app on its own data directory, cleaned up by the returned close(). */
export function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "slide-studio-test-"));
  const app = createApp({ host: "127.0.0.1", port: 0, data: directory });
  return {
    ...app,
    close() {
      app.events.close();
      app.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function addItem(library, kind, name, extra = {}) {
  return library.create({
    kind,
    name,
    description: extra.description || "",
    usage: extra.usage || "",
    tags: extra.tags || "",
    contentType: "image/png",
    bytes: solidPng(extra.width || 1200, extra.height || 1600),
  });
}
