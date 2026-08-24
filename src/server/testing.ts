import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { LibraryItem, LibraryKind } from "../shared/schema/index.js";
import { dataPaths, openDb } from "./db/open.js";
import { HttpError } from "./errors.js";
import { EventBus } from "./services/events.js";
import { LibraryService } from "./services/library.js";
import { MediaStore } from "./services/media.js";
import { ProjectService } from "./services/projects.js";
import { buildApp } from "./app.js";

const CRC = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC[index] = value >>> 0;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A real PNG, so the header parser has something honest to read. */
export function solidPng(
  width: number,
  height: number,
  colour: readonly [number, number, number] = [128, 128, 128],
): Buffer {
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

export interface TestApp {
  db: DatabaseSync;
  events: EventBus;
  services: {
    library: LibraryService;
    projects: ProjectService;
    media: MediaStore;
  };
  close(): void;
}

/** The services on a throwaway data directory, cleaned up by the returned close(). */
export function createTestApp(): TestApp {
  const directory = mkdtempSync(join(tmpdir(), "slide-studio-test-"));
  const paths = dataPaths(directory);
  const db = openDb(paths.database);
  const media = new MediaStore(paths.media);
  const events = new EventBus();
  const library = new LibraryService(db, media);
  const projects = new ProjectService(db, events, library);
  return {
    db,
    events,
    services: { library, projects, media },
    close() {
      events.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * The whole app on a throwaway data directory. `await app.close()` closes the
 * database, drops the subscribers and removes the directory, so a test needs
 * nothing else in its afterEach.
 */
export async function makeTempApp(
  options: { allowedHosts?: string[] } = {},
): Promise<FastifyInstance> {
  const directory = mkdtempSync(join(tmpdir(), "slide-studio-app-"));
  const app = await buildApp({
    dataDir: directory,
    baseUrl: () => "http://127.0.0.1:4173",
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
  });
  app.addHook("onClose", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

/** A base64 PNG of that size, the way an agent sends one to POST /api/library. */
export function pngFixture(width: number, height: number): string {
  return solidPng(width, height).toString("base64");
}

export async function addItem(
  library: LibraryService,
  kind: LibraryKind,
  name: string,
  extra: {
    description?: string;
    usage?: string;
    tags?: string;
    width?: number;
    height?: number;
  } = {},
): Promise<LibraryItem> {
  return library.create({
    kind,
    name,
    description: extra.description ?? "",
    usage: extra.usage ?? "",
    tags: extra.tags ?? "",
    contentType: "image/png",
    bytes: solidPng(extra.width ?? 1200, extra.height ?? 1600),
  });
}

/** Narrows a caught value to the HttpError the services throw. */
export function asHttpError(error: unknown): HttpError {
  if (!(error instanceof HttpError))
    throw new Error(`Expected an HttpError, got ${String(error)}`);
  return error;
}

/** Runs `fn`, catching either a synchronous throw or a rejected promise. */
export async function catchError(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}
