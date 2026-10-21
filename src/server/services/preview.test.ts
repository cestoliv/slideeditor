import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addItem, createTestApp, noisyPng, type TestApp } from "../testing.js";
import { previewHeight, renderPreview, type PreviewServices } from "./preview.js";

let harness: TestApp;
let services: PreviewServices;

beforeEach(() => {
  harness = createTestApp();
  services = {
    library: harness.services.library,
    media: harness.services.media,
    fonts: harness.services.fonts,
  };
  // The preview reads fonts and images from disk only. A fetch here is a bug.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in a preview."));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  harness.close();
});

/** A 9:16 slide over a fresh background, with whatever layers the test adds. */
async function slideWith(layers: { overlays?: unknown[]; texts?: unknown[] }) {
  const background = await addItem(harness.services.library, "background", "Sky");
  return {
    ratio: { w: 9, h: 16 },
    slides: [
      {
        id: "s1",
        backgroundItemId: background.id,
        width: background.width,
        height: background.height,
        overlays: layers.overlays ?? [],
        texts: layers.texts ?? [],
      },
    ],
  };
}

function text(fields: Record<string, unknown>) {
  return { id: "t1", text: "Hello", x: 0.1, y: 0.4, width: 0.6, height: 0.1, ...fields };
}

it("draws every layer style into a JPEG at the preview size", async () => {
  const asset = await addItem(harness.services.library, "asset", "Arrow", {
    width: 200,
    height: 100,
  });
  const document = await slideWith({
    overlays: [
      { id: "o1", itemId: asset.id, x: 0.1, y: 0.1, width: 0.3, cropW: 0.5, z: 1 },
    ],
    texts: [
      text({ id: "a", y: 0.3, style: "boxed", backgroundShape: "lines", z: 2 }),
      text({ id: "b", y: 0.5, style: "boxed", backgroundShape: "full", z: 3 }),
      text({
        id: "c",
        y: 0.7,
        style: "outline",
        underline: true,
        strikethrough: true,
        z: 4,
      }),
      text({ id: "d", y: 0.65, style: "plain", align: "left", italic: true, z: 5 }),
    ],
  });

  const { slides, warnings } = await renderPreview(services, document, [1], 270);

  expect(warnings).toEqual([]);
  expect(slides).toHaveLength(1);
  expect(await sharp(slides[0]?.jpeg).metadata()).toMatchObject({
    format: "jpeg",
    width: 270,
    height: previewHeight(document.ratio, 270),
  });
});

it("warns when a text has more lines than its box shows", async () => {
  const long = "This caption is far too long to fit in a box only one line tall";
  const document = await slideWith({ texts: [text({ text: long, height: 0.03 })] });

  const { warnings } = await renderPreview(services, document, [1], 270);

  expect(warnings).toEqual([
    expect.objectContaining({ slide: 1, type: "text-cut", text: long }),
  ]);
});

it("warns when a text box reaches past the slide edge", async () => {
  const document = await slideWith({ texts: [text({ y: 0.95 })] });

  const { warnings } = await renderPreview(services, document, [1], 270);

  expect(warnings.map((warning) => warning.type)).toEqual([
    "text-out-of-frame",
    "outside-safe-zone",
  ]);
});

it("warns when a text or an image leaves the safe zone, and not inside it", async () => {
  const asset = await addItem(harness.services.library, "asset", "Arrow");
  const overlay = { id: "o1", itemId: asset.id, x: 0.5, y: 0.1, width: 0.4, z: 1 };
  const document = await slideWith({
    overlays: [overlay],
    texts: [text({ y: 0.75, z: 2 })],
  });

  const { warnings } = await renderPreview(services, document, [1], 270);

  expect(warnings).toEqual([
    expect.objectContaining({ type: "outside-safe-zone", itemId: asset.id }),
    expect.objectContaining({ type: "outside-safe-zone", text: "Hello" }),
  ]);
});

it("warns when an image sits over a text, and not when it sits under one", async () => {
  const asset = await addItem(harness.services.library, "asset", "Arrow");
  const over = { id: "o1", itemId: asset.id, x: 0.2, y: 0.35, width: 0.4, z: 2 };
  const document = await slideWith({ overlays: [over], texts: [text({ z: 1 })] });

  const above = await renderPreview(services, document, [1], 270);
  document.slides[0]!.overlays = [{ ...over, z: 0 }];
  const below = await renderPreview(services, document, [1], 270);

  expect(above.warnings.map((warning) => warning.type)).toEqual(["overlay-over-text"]);
  expect(below.warnings).toEqual([]);
});

it("draws only the cropped part of an overlay", async () => {
  // Left half red, right half blue. A crop to the right half shows only blue.
  const halves = await sharp({
    create: { width: 200, height: 100, channels: 3, background: "#ff0000" },
  })
    .composite([
      {
        input: {
          create: { width: 100, height: 100, channels: 3, background: "#0000ff" },
        },
        left: 100,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const asset = await harness.services.library.create({
    kind: "asset",
    name: "Halves",
    description: "",
    usage: "",
    tags: "",
    contentType: "image/png",
    bytes: halves,
    accountId: "default",
  });
  const document = await slideWith({
    overlays: [
      {
        id: "o1",
        itemId: asset.id,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        cropX: 0.5,
        cropW: 0.5,
      },
    ],
  });

  const { slides } = await renderPreview(services, document, [1], 108);
  const { data } = await sharp(slides[0]?.jpeg)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let red = 0;
  for (let index = 0; index < data.length; index += 3) {
    if ((data[index] ?? 0) > 128 && (data[index + 2] ?? 0) < 128) red += 1;
  }
  expect(red).toBe(0);
});

it("renders a large photo under a tight crop at full width", async () => {
  // librsvg refuses an SVG over 10 MB, which a whole photo resized up to its
  // crop scale and embedded as PNG easily reaches.
  const photo = await harness.services.library.create({
    kind: "asset",
    name: "Photo",
    description: "",
    usage: "",
    tags: "",
    contentType: "image/png",
    bytes: await noisyPng(1080, 1920),
    accountId: "default",
  });
  const document = await slideWith({
    overlays: [
      { id: "o1", itemId: photo.id, x: 0, y: 0, width: 1, cropW: 0.05, cropH: 0.05 },
    ],
    texts: [text({ text: "Bell \u0007 and nul \u0000 inside" })],
  });

  const { slides } = await renderPreview(services, document, [1], 1080);

  expect(await sharp(slides[0]?.jpeg).metadata()).toMatchObject({ width: 1080 });
});
