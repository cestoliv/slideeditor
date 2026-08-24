import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  MediaStore,
  extensionForType,
  imageDimensions,
  typeForExtension,
} from "./media.js";
import { solidPng } from "../testing.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slide-media-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

// Ported from the old suite, where these two sat beside the library tests.

it("reads dimensions from the PNG header", () => {
  expect(imageDimensions(solidPng(640, 480))).toEqual({ width: 640, height: 480 });
});

it("returns null for a format it cannot decode", () => {
  expect(imageDimensions(Buffer.from("<svg width='10'/>"))).toBeNull();
});

// ---------------------------------------------------------------------------
// New with the port.

it("returns the same id for identical bytes and writes the file once", async () => {
  const store = new MediaStore(join(directory, "media"));
  const bytes = solidPng(8, 6);
  const first = await store.put(bytes, "png");
  const second = await store.put(bytes, "png");

  expect(first).toBe(second);
  expect(first, "the id is the lowercase hex sha256 of the bytes").toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(readdirSync(join(directory, "media"))).toEqual([`${first}.png`]);
  expect(readFileSync(store.pathFor(first, "png")).equals(bytes)).toBe(true);
});

it("gives different bytes different ids", async () => {
  const store = new MediaStore(join(directory, "media"));
  expect(await store.put(solidPng(8, 6), "png")).not.toBe(
    await store.put(solidPng(6, 8), "png"),
  );
});

it("stores one intact file when many callers upload the same image at once", async () => {
  const store = new MediaStore(directory);
  // Incompressible and large enough that a write cannot finish inside one turn
  // of the loop, so the calls really do overlap.
  const bytes = randomBytes(4 * 1024 * 1024);
  const digest = createHash("sha256").update(bytes).digest("hex");

  const ids = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes, "png")));

  expect(new Set(ids)).toEqual(new Set([digest]));
  expect(readdirSync(directory), "one file, and no temporary left behind").toEqual([
    `${digest}.png`,
  ]);
  expect(
    createHash("sha256")
      .update(readFileSync(store.pathFor(digest, "png")))
      .digest("hex"),
    "the stored bytes must be the ones the name promises",
  ).toBe(digest);
});

it("gives every concurrent call its own temporary file", async () => {
  const store = new MediaStore(directory);
  const bytes = randomBytes(4 * 1024 * 1024);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = store.pathFor(digest, "png");
  const temporaries = new Set<string>();
  const lengths = new Set<number>();

  // Watches the directory while eight uploads of one image are in flight. This
  // is the mechanism the corruption needed, not a symptom of it: two calls
  // writing one path is what let a half-written file be renamed into place
  // under a hash promising it was whole. Every call starts before any of them
  // reaches its first await, so all eight are writing at once.
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        for (const name of readdirSync(directory))
          if (name.endsWith(".tmp")) temporaries.add(name);
        lengths.add(readFileSync(target).length);
      } catch {
        // Not published yet, which is the other legal answer for a reader.
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

  // The stop has to survive a failing upload, or the loop outlives this test
  // and reads a directory the next one has already deleted.
  let ids: string[];
  try {
    ids = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes, "png")));
  } finally {
    watching = false;
    await watcher;
  }

  expect(new Set(ids)).toEqual(new Set([digest]));
  expect(temporaries.size, "eight writers, eight temporary files, no shared path").toBe(
    8,
  );
  expect(lengths, "and the published file is whole every time a reader looks").toEqual(
    new Set([bytes.length]),
  );
});

it("leaves no temporary file behind", async () => {
  const store = new MediaStore(directory);
  await store.put(solidPng(4, 4), "png");
  expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("removes a file and forgives one that is already gone", async () => {
  const store = new MediaStore(directory);
  const id = await store.put(solidPng(4, 4), "png");
  expect(store.exists(id, "png")).toBe(true);
  await store.remove(id, "png");
  expect(store.exists(id, "png")).toBe(false);
  await expect(store.remove(id, "png")).resolves.toBeUndefined();
});

it("maps every content type the app accepts", () => {
  expect(extensionForType("image/png")).toBe("png");
  expect(extensionForType("image/jpeg")).toBe("jpg");
  expect(extensionForType("image/webp")).toBe("webp");
  expect(extensionForType("image/gif")).toBe("gif");
  expect(extensionForType("image/avif")).toBe("avif");
  expect(extensionForType("image/svg+xml")).toBe("svg");
});

it("ignores case and parameters, and refuses anything else", () => {
  expect(extensionForType("IMAGE/PNG")).toBe("png");
  expect(extensionForType("image/png; charset=binary")).toBe("png");
  expect(extensionForType("  image/webp  ")).toBe("webp");
  expect(extensionForType("image/jpg"), "jpg is not a content type").toBeNull();
  expect(extensionForType("application/pdf")).toBeNull();
  expect(extensionForType("")).toBeNull();
});

it("maps an extension back to its content type", () => {
  expect(typeForExtension("png")).toBe("image/png");
  expect(typeForExtension("jpg")).toBe("image/jpeg");
  expect(typeForExtension("svg")).toBe("image/svg+xml");
  expect(typeForExtension("exe")).toBe("application/octet-stream");
});

it("reads a JPEG SOF marker", () => {
  expect(imageDimensions(jpeg(0xc0, 300, 200))).toEqual({ width: 300, height: 200 });
  // 0xc2 is progressive, still a frame header.
  expect(imageDimensions(jpeg(0xc2, 64, 48))).toEqual({ width: 64, height: 48 });
});

it("skips the JPEG segments that are not frame headers", () => {
  // A DHT (0xc4) before the real SOF must be skipped by its declared length.
  const noise = Buffer.alloc(20, 0x5a);
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4]), lengthPrefixed(noise)]);
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    dht,
    sofSegment(0xc0, 111, 222),
    Buffer.alloc(16),
  ]);
  expect(imageDimensions(bytes)).toEqual({ width: 111, height: 222 });
});

it("reads a GIF header", () => {
  const bytes = Buffer.alloc(16);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(320, 6);
  bytes.writeUInt16LE(240, 8);
  expect(imageDimensions(bytes)).toEqual({ width: 320, height: 240 });
});

it("reads a WebP VP8 header", () => {
  const bytes = webp("VP8 ");
  bytes.writeUInt16LE(640 | 0xc000, 26);
  bytes.writeUInt16LE(360 | 0x8000, 28);
  expect(imageDimensions(bytes), "the two high scale bits are masked off").toEqual({
    width: 640,
    height: 360,
  });
});

it("reads the other two WebP layouts", () => {
  const extended = webp("VP8X");
  extended.writeUIntLE(1279, 24, 3);
  extended.writeUIntLE(719, 27, 3);
  expect(imageDimensions(extended), "VP8X stores each field minus one").toEqual({
    width: 1280,
    height: 720,
  });

  const lossless = webp("VP8L");
  lossless.writeUInt32LE((99 - 1) | ((55 - 1) << 14), 21);
  expect(imageDimensions(lossless)).toEqual({ width: 99, height: 55 });
});

it("returns null for a truncated or unknown header", () => {
  expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  expect(
    imageDimensions(solidPng(4, 4).subarray(0, 20)),
    "a PNG needs 24 bytes",
  ).toBeNull();
  expect(imageDimensions(webp("XXXX")), "an unknown WebP chunk").toBeNull();
  expect(
    imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    "a JPEG with no frame header",
  ).toBeNull();
});

function lengthPrefixed(payload: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([head, payload]);
}

function sofSegment(marker: number, width: number, height: number): Buffer {
  const payload = Buffer.alloc(7);
  payload.writeUInt16BE(payload.length + 2, 0);
  payload[2] = 8;
  payload.writeUInt16BE(height, 3);
  payload.writeUInt16BE(width, 5);
  return Buffer.concat([Buffer.from([0xff, marker]), payload]);
}

function jpeg(marker: number, width: number, height: number): Buffer {
  // The trailing padding keeps the scan loop's `offset + 9 < length` guard true.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sofSegment(marker, width, height),
    Buffer.alloc(16),
  ]);
}

function webp(chunk: string): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write(chunk, 12, "ascii");
  return bytes;
}
