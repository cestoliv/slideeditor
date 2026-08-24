import { afterEach, expect, it } from "vitest";
import {
  ComposeError,
  composeDocument,
  toComposition,
  validateComposition,
} from "../../shared/compose/index.js";
import { outputHeight } from "../../shared/geometry/index.js";
import type { LibraryItem, SlideDocument } from "../../shared/schema/index.js";
import { addItem, createTestApp, type TestApp } from "../testing.js";
import type { LibraryService } from "./library.js";

// Ported from the old node:test suite, which drove compose through a real
// library. The engine itself now lives in src/shared/compose, so this file
// sits beside the service it borrows rather than beside the engine.

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

interface Fixture {
  library: LibraryService;
  background: LibraryItem;
  wide: LibraryItem;
  square: LibraryItem;
  tall: LibraryItem;
}

async function fixture(): Promise<Fixture> {
  app = createTestApp();
  const { library } = app.services;
  return {
    library,
    background: await addItem(library, "background", "Backdrop", {
      width: 1200,
      height: 1600,
    }),
    wide: await addItem(library, "asset", "Wide", { width: 800, height: 400 }),
    square: await addItem(library, "asset", "Square", { width: 500, height: 500 }),
    tall: await addItem(library, "asset", "Tall", { width: 400, height: 900 }),
  };
}

/** Everything must sit inside the canvas and clear of the text block. */
function assertWellFormed(document: SlideDocument, label: string): void {
  const height = outputHeight(document.ratio);
  document.slides.forEach((slide, index) => {
    const where = `${label} slide ${index + 1}`;
    for (const overlay of slide.overlays) {
      const overlayHeight = overlay.height ?? 0;
      expect(
        overlay.x >= -0.001 && overlay.x + overlay.width <= 1.001,
        `${where}: overlay outside horizontally`,
      ).toBe(true);
      expect(
        overlay.y >= -0.001 && overlay.y + overlayHeight <= 1.001,
        `${where}: overlay outside vertically`,
      ).toBe(true);
      expect(
        overlay.width > 0 && overlayHeight > 0,
        `${where}: overlay has no size`,
      ).toBe(true);
    }
    for (const text of slide.texts) {
      expect(
        text.y >= -0.001 && text.y + text.height <= 1.001,
        `${where}: text outside vertically`,
      ).toBe(true);
    }
    const textTop = slide.texts.length
      ? Math.min(...slide.texts.map((text) => text.y))
      : 1;
    for (const overlay of slide.overlays) {
      expect(
        overlay.y + (overlay.height ?? 0) <= textTop + 0.001,
        `${where}: overlay overlaps the text block`,
      ).toBe(true);
    }
    expect(height > 0).toBe(true);
  });
}

it("computes even output heights from the ratio", () => {
  expect(outputHeight({ w: 9, h: 16 })).toBe(1920);
  expect(outputHeight({ w: 4, h: 5 })).toBe(1350);
  expect(outputHeight({ w: 3, h: 4 })).toBe(1440);
  expect(outputHeight({ w: 1, h: 1 })).toBe(1080);
  expect(outputHeight({ w: 1.91, h: 1 })).toBe(566);
  expect(outputHeight({ w: 1.91, h: 1 }) % 2).toBe(0);
});

it("lays out every ratio without overflow or overlap", async () => {
  const f = await fixture();
  const ratios = [
    { w: 9, h: 16 },
    { w: 3, h: 4 },
    { w: 4, h: 5 },
    { w: 1, h: 1 },
    { w: 1.91, h: 1 },
  ];
  for (const ratio of ratios) {
    const document = composeDocument({
      ratio,
      library: f.library,
      slides: [
        { background: f.background.id, assets: [f.wide.id], texts: ["Short line"] },
        {
          background: f.background.id,
          assets: [f.wide.id, f.square.id, f.tall.id],
          texts: ["One", "Two", "Three"],
        },
        {
          background: f.background.id,
          assets: [],
          texts: [
            "A much longer line that certainly has to wrap more than once on a narrow canvas",
          ],
        },
        { background: f.background.id, assets: [f.square.id], texts: [] },
      ],
    });
    assertWellFormed(document, `${ratio.w}:${ratio.h}`);
  }
});

it("keeps every asset undistorted", async () => {
  const f = await fixture();
  const ratio = { w: 4, h: 5 };
  const height = outputHeight(ratio);
  const document = composeDocument({
    ratio,
    library: f.library,
    slides: [
      {
        background: f.background.id,
        assets: [f.wide.id, f.square.id, f.tall.id],
        texts: ["Caption"],
      },
    ],
  });
  const sources = [f.wide, f.square, f.tall];
  document.slides[0]!.overlays.forEach((overlay, index) => {
    const drawn = (overlay.width * 1080) / ((overlay.height ?? 0) * height);
    const source = sources[index]!;
    const sourceAspect = source.width / source.height;
    expect(
      Math.abs(drawn - sourceAspect) < 0.01,
      `asset ${index} distorted: ${drawn} vs ${sourceAspect}`,
    ).toBe(true);
  });
});

it("gives a partial last row the same item size as a full row", async () => {
  const f = await fixture();
  const document = composeDocument({
    ratio: { w: 4, h: 5 },
    library: f.library,
    slides: [
      {
        background: f.background.id,
        assets: [f.square.id, f.square.id, f.square.id, f.square.id],
        texts: [],
      },
    ],
  });
  const widths = document.slides[0]!.overlays.map((overlay) => overlay.width);
  expect(
    Math.max(...widths) - Math.min(...widths) < 0.001,
    `widths drifted: ${widths.join(", ")}`,
  ).toBe(true);
});

it("shrinks text rather than running off the canvas", async () => {
  const f = await fixture();
  const long = "word ".repeat(90).trim();
  const document = composeDocument({
    ratio: { w: 1.91, h: 1 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [], texts: [long, long] }],
  });
  assertWellFormed(document, "long text");
  expect(document.slides[0]!.texts[0]!.size).toBeLessThanOrEqual(64);
});

it("produces identical geometry for identical input", async () => {
  const f = await fixture();
  const build = () =>
    composeDocument({
      ratio: { w: 9, h: 16 },
      library: f.library,
      slides: [
        {
          background: f.background.id,
          assets: [f.wide.id, f.square.id],
          texts: ["Alpha", "Beta"],
        },
      ],
    });
  const strip = (doc: SlideDocument) =>
    JSON.stringify(doc, (key, value) => (key === "id" ? undefined : value));
  expect(strip(build())).toBe(strip(build()));
});

it("leaves an unchanged slide byte-identical on edit", async () => {
  const f = await fixture();
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [
      { background: f.background.id, assets: [f.wide.id], texts: ["Keep me"] },
      { background: f.background.id, assets: [f.square.id], texts: ["Change me"] },
    ],
  });
  // Stand in for the human moving things around.
  first.slides[0]!.overlays[0]!.x = 0.4321;
  first.slides[0]!.texts[0]!.color = "#123456";

  const second = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    previous: first,
    slides: [
      { background: f.background.id, assets: [f.wide.id], texts: ["Keep me"] },
      {
        background: f.background.id,
        assets: [f.square.id, f.tall.id],
        texts: ["Change me", "And add"],
      },
    ],
  });
  expect(second.slides[0], "an untouched composition must not be relaid out").toEqual(
    first.slides[0],
  );
  expect(second.slides[1]!.overlays.length).toBe(2);
  expect(second.slides[1]!.texts.length).toBe(2);
});

it("preserves geometry for items that survive a slide edit", async () => {
  const f = await fixture();
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Stays"] }],
  });
  first.slides[0]!.overlays[0]!.x = 0.77;
  first.slides[0]!.overlays[0]!.rotation = 31;
  first.slides[0]!.texts[0]!.y = 0.11;

  const second = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    previous: first,
    slides: [
      {
        background: f.background.id,
        assets: [f.wide.id, f.square.id],
        texts: ["Stays", "New"],
      },
    ],
  });
  const kept = second.slides[0]!.overlays.find((overlay) => overlay.itemId === f.wide.id);
  expect(kept?.x).toBe(0.77);
  expect(kept?.rotation).toBe(31);
  expect(second.slides[0]!.texts.find((text) => text.text === "Stays")?.y).toBe(0.11);
});

it("relays out from scratch when the ratio changes", async () => {
  const f = await fixture();
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Line"] }],
  });
  first.slides[0]!.overlays[0]!.x = 0.77;
  const second = composeDocument({
    ratio: { w: 1, h: 1 },
    library: f.library,
    previous: first,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Line"] }],
  });
  expect(
    second.slides[0]!.overlays[0]!.x,
    "a new ratio invalidates the old geometry",
  ).not.toBe(0.77);
  assertWellFormed(second, "after ratio change");
});

it("round-trips a composition", async () => {
  const f = await fixture();
  const slides = [
    {
      background: f.background.id,
      assets: [f.wide.id, f.square.id],
      texts: ["One", "Two"],
    },
  ];
  const document = composeDocument({ ratio: { w: 4, h: 5 }, library: f.library, slides });
  const back = toComposition({ id: "x", name: "n", version: 1, ...document });
  expect(back.slides[0]?.background).toEqual(slides[0]?.background);
  expect(back.slides[0]?.assets).toEqual(slides[0]?.assets);
  expect(back.slides[0]?.texts).toEqual(slides[0]?.texts);
});

// The old suite asserted status 400 on these two, because compose.mjs threw the
// server's own HttpError. The engine is shared with the browser now, so it
// throws ComposeError and the 400 is Task 8's to map (src/shared/compose/compose.ts:29-38).
it("rejects malformed compositions", () => {
  expect(() => validateComposition([])).toThrow(ComposeError);
  expect(() => validateComposition([{ texts: ["no background"] }])).toThrow(ComposeError);
  expect(() => validateComposition(null)).toThrow(ComposeError);
});

it("rejects a ratio outside the supported band", async () => {
  const f = await fixture();
  expect(() =>
    composeDocument({
      ratio: { w: 1, h: 5 },
      library: f.library,
      slides: [{ background: f.background.id }],
    }),
  ).toThrow(ComposeError);
});
