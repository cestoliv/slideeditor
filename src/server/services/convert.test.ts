import { expect, it } from "vitest";
import sharp from "sharp";
import { convertRender, extensionFor, mimeTypeFor } from "./convert.js";

/**
 * A 1080x1350 image whose top-left quarter is fully transparent and whose rest
 * is solid red. Built with sharp rather than the repo's solidPng helper, which
 * writes no alpha channel and so could not show the matte doing anything.
 */
async function transparentCorner(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 1080,
      height: 1350,
      channels: 4,
      background: { r: 220, g: 20, b: 60, alpha: 1 },
    },
  })
    .composite([
      {
        // Opaque, so dest-out punches a hole exactly here. sharp extends a
        // composite smaller than the canvas with transparent pixels, and
        // dest-out is the identity where the source is transparent, so the
        // rest of the canvas is untouched.
        input: await sharp({
          create: {
            width: 540,
            height: 675,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        top: 0,
        left: 0,
        blend: "dest-out",
      },
    ])
    .png()
    .toBuffer();
}

/** One pixel's three channels, read out of the converted bytes. */
async function pixelAt(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, info.channels)];
}

it("flattens transparency onto white and drops the alpha channel", async () => {
  const converted = await convertRender(await transparentCorner(), "jpeg", 92);
  const metadata = await sharp(converted.bytes).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.hasAlpha).toBe(false);
  // The transparent corner reads white, not black and not the platform's guess.
  const corner = await pixelAt(converted.bytes, 10, 10);
  for (const channel of corner) expect(channel).toBeGreaterThanOrEqual(250);
});

it("leaves an opaque pixel where it was", async () => {
  const converted = await convertRender(await transparentCorner(), "jpeg", 92);
  const [red, green, blue] = await pixelAt(converted.bytes, 900, 1200);
  expect(Math.abs((red ?? 0) - 220)).toBeLessThanOrEqual(4);
  expect(Math.abs((green ?? 0) - 20)).toBeLessThanOrEqual(4);
  expect(Math.abs((blue ?? 0) - 60)).toBeLessThanOrEqual(4);
});

it("reports the converted image's own dimensions", async () => {
  const converted = await convertRender(await transparentCorner(), "jpeg", 92);
  expect([converted.width, converted.height]).toEqual([1080, 1350]);
});

it("spends fewer bytes at a lower quality", async () => {
  const png = await transparentCorner();
  const cheap = await convertRender(png, "jpeg", 40);
  const dear = await convertRender(png, "jpeg", 92);
  expect(cheap.bytes.byteLength).toBeLessThan(dear.bytes.byteLength);
});

it("encodes webp when webp is asked for", async () => {
  const converted = await convertRender(await transparentCorner(), "webp", 92);
  const metadata = await sharp(converted.bytes).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.hasAlpha).toBe(false);
});

it("names the extension and the media type of each format", () => {
  expect(extensionFor("png")).toBe("png");
  expect(extensionFor("jpeg")).toBe("jpg");
  expect(extensionFor("webp")).toBe("webp");
  expect(mimeTypeFor("png")).toBe("image/png");
  expect(mimeTypeFor("jpeg")).toBe("image/jpeg");
  expect(mimeTypeFor("webp")).toBe("image/webp");
});
