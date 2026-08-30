import { expect, it, vi } from "vitest";
import { fixtureProject } from "../testing.js";
import { blobToBase64, publishRenders } from "./publish.js";

it("turns a blob into bare base64, with no data URL prefix", async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const encoded = await blobToBase64(blob);
  expect(encoded).toBe("iVBORw==");
});

/*
 * blobToBase64 chunks its input (CHUNK = 0x8000) to keep
 * String.fromCharCode's argument spread bounded. A buffer under that size
 * exercises the loop exactly once, which would pass even if btoa ran per
 * chunk instead of once over the whole binary string — and base64 pads at
 * each encoding's end, so per-chunk encoding corrupts every real upload
 * larger than one chunk. This buffer crosses the boundary, and its length is
 * a multiple of neither 3 nor CHUNK, so both the chunk boundary and base64's
 * own padding are exercised.
 */
it("base64-encodes a buffer that crosses the chunk boundary without corrupting it", async () => {
  const length = 0x8000 + 2;
  const bytes = Uint8Array.from({ length }, (_unused, index) => index % 256);
  const encoded = await blobToBase64(new Blob([bytes]));
  // Computed independently of blobToBase64's own chunking: one binary string
  // built in a single pass, then one btoa call over the whole thing.
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  expect(encoded).toBe(btoa(binary));
});

it("uploads one render per slide, in slide order", async () => {
  const uploaded: number[] = [];
  const upload = vi.fn(async (index: number) => {
    uploaded.push(index);
  });
  const count = await publishRenders({
    project: fixtureProject({ slides: 3 }),
    library: new Map(),
    upload,
  });
  expect(count).toBe(3);
  expect(uploaded).toEqual([0, 1, 2]);
});

it("stops at the first failure rather than leaving a half set unreported", async () => {
  const upload = vi.fn(async (index: number) => {
    if (index === 1) throw new Error("network");
  });
  await expect(
    publishRenders({
      project: fixtureProject({ slides: 3 }),
      library: new Map(),
      upload,
    }),
  ).rejects.toThrow("network");
  expect(upload).toHaveBeenCalledTimes(2);
});
