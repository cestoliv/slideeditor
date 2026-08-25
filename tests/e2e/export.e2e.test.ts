import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  baseUrl,
  captureDownloads,
  createSlideshow,
  editPath,
  openApp,
  seedLibrary,
} from "./setup/fixtures.js";
import type { CapturedDownload } from "./setup/fixtures.js";

/*
 * The export, taken all the way to the bytes. The renders happen in a real
 * Chromium against images the real server stored, and the archive is unpacked
 * here by a reader that shares no code with the writer, so a writer that agrees
 * with itself cannot pass this.
 */

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

/** Watches what the app hands the browser for the length of one test. */
function watchDownloads(): CapturedDownload[] {
  const { downloads, stop } = captureDownloads();
  release = stop;
  return downloads;
}

it("exports the active slide as a 1080-wide PNG", async () => {
  const { backgrounds, assets } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Export one",
    ratio: { w: 4, h: 5 },
    slides: [
      {
        background: backgrounds[0]!.id,
        assets: [assets[1]!.id],
        texts: ["One slide, full resolution"],
      },
    ],
  });
  await openApp(editPath(created.editUrl));
  await expect
    .element(page.getByLabelText("Text layer: One slide, full resolution"))
    .toBeVisible();

  const downloads = watchDownloads();
  await userEvent.click(page.getByLabelText("Download current slide as PNG"));
  // The toast is the app saying the export finished, and it is downstream of the
  // download itself rather than merely later than the click.
  await expect.element(page.getByText("PNG downloaded at full resolution")).toBeVisible();

  expect(downloads).toHaveLength(1);
  const png = downloads[0]!;
  expect(png.filename).toBe("export-one-slide-1.png");
  expect(png.blob.type).toBe("image/png");
  const bitmap = await createImageBitmap(png.blob);
  expect(bitmap.width).toBe(1080);
  expect(bitmap.height).toBe(1350);
});

it("exports every slide as a ZIP holding one PNG each", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Export all",
    // Not square: 1080 x 1080 passes under any mutation that swaps or equalises
    // the two axes, which is a real class of export bug.
    ratio: { w: 3, h: 4 },
    slides: [
      { background: backgrounds[0]!.id, texts: ["First"] },
      { background: backgrounds[1]!.id, texts: ["Second"] },
      { background: backgrounds[3]!.id, texts: ["Third"] },
    ],
  });
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText("Text layer: First")).toBeVisible();

  const downloads = watchDownloads();
  await userEvent.click(page.getByLabelText("Download all slides as a ZIP"));
  await expect.element(page.getByText("3 slides downloaded as a ZIP")).toBeVisible();

  expect(downloads).toHaveLength(1);
  const archive = downloads[0]!;
  expect(archive.filename).toBe("export-all.zip");

  const entries = readZip(new Uint8Array(await archive.blob.arrayBuffer()));
  expect(entries.map((entry) => entry.name)).toEqual([
    "01-export-all-slide-1.png",
    "02-export-all-slide-2.png",
    "03-export-all-slide-3.png",
  ]);
  for (const entry of entries) {
    const bitmap = await createImageBitmap(new Blob([entry.data], { type: "image/png" }));
    expect(bitmap.width, entry.name).toBe(1080);
    expect(bitmap.height, entry.name).toBe(1440);
  }
});

// The buffer is named, because a Blob refuses an array over a SharedArrayBuffer
// and a bare Uint8Array might be backed by one.
type ZipRead = { name: string; data: Uint8Array<ArrayBuffer> };

/**
 * Reads a stored ZIP through its central directory.
 *
 * Written here rather than borrowed from the app, because a reader that shares
 * the writer's idea of the format would agree with a wrong one.
 */
function readZip(bytes: Uint8Array<ArrayBuffer>): ZipRead[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("The archive has no end-of-central-directory record.");

  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ZipRead[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`Central directory entry ${String(index)} has no signature.`);
    }
    const method = view.getUint16(cursor + 10, true);
    if (method !== 0) throw new Error("This reader only unpacks stored entries.");
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    if (view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error(`${name} has no local header.`);
    }
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    entries.push({ name, data: bytes.subarray(start, start + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
