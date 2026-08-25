import { describe, expect, it } from "vitest";
import type { LibraryItem, Slide, SlideDocument } from "../schema/index.js";
import {
  ComposeError,
  composeDocument,
  toComposition,
  validateComposition,
} from "./compose.js";
import type { Composition, LibraryLookup } from "./compose.js";
import {
  ASSET_TOP_MARGIN,
  SIDE_MARGIN,
  TEXT_SIZE_FLOOR,
  TEXT_TOP_LIMIT,
} from "./constants.js";

// compose reads only id, kind, width and height off a library item, so the
// stub carries those and nothing else.
type StubItem = Pick<LibraryItem, "id" | "kind" | "width" | "height">;

const items: Record<string, StubItem> = {
  bg1: { id: "bg1", kind: "background", width: 1080, height: 1920 },
  bg2: { id: "bg2", kind: "background", width: 1200, height: 1200 },
  a1: { id: "a1", kind: "asset", width: 400, height: 200 },
  a2: { id: "a2", kind: "asset", width: 200, height: 400 },
  a3: { id: "a3", kind: "asset", width: 300, height: 300 },
  a4: { id: "a4", kind: "asset", width: 500, height: 100 },
};

const library: LibraryLookup = {
  require: (id) => {
    const item = items[id];
    if (!item) throw new Error(`No library item with id ${id}`);
    return item as LibraryItem;
  },
};

/**
 * Deterministic ids, so a diff between two runs is a geometry diff. One
 * generator serves the whole file, so no id is ever handed out twice and an
 * assertion that two ids match proves the layer was reused.
 */
function counter(): () => string {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

const newId = counter();

function at<T>(list: T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

function firstSlide(doc: SlideDocument): Slide {
  return at(doc.slides, 0);
}

const PORTRAIT = { w: 9, h: 16 };

function compose(
  slides: Composition[],
  options: { ratio?: { w: number; h: number }; previous?: SlideDocument | null } = {},
): SlideDocument {
  return composeDocument({
    ratio: options.ratio ?? PORTRAIT,
    slides,
    library,
    previous: options.previous ?? null,
    newId,
  });
}

describe("preserving work a human did by hand", () => {
  it("keeps an untouched slide byte for byte", () => {
    const composition: Composition[] = [
      { background: "bg1", assets: ["a1"], texts: ["Short line"] },
    ];
    const first = compose(composition);
    const second = compose(composition, { previous: first });
    expect(firstSlide(second)).toBe(firstSlide(first));
  });

  it("keeps a hand-placed overlay when the same asset is still on the slide", () => {
    const first = compose([{ background: "bg1", assets: ["a1"], texts: ["Short line"] }]);
    const moved = at(firstSlide(first).overlays, 0);
    moved.x = 0.11;
    moved.y = 0.22;
    moved.rotation = 17;

    // The text changed, so the slide is recomposed rather than returned whole.
    const second = compose(
      [{ background: "bg1", assets: ["a1"], texts: ["A different line"] }],
      {
        previous: first,
      },
    );
    const kept = at(firstSlide(second).overlays, 0);
    expect(kept.x).toBe(0.11);
    expect(kept.y).toBe(0.22);
    expect(kept.rotation).toBe(17);
    expect(kept.id).toBe(moved.id);
  });

  it("keeps both hand-placed overlays when the same asset appears twice", () => {
    const first = compose([
      { background: "bg1", assets: ["a1", "a1"], texts: ["Short line"] },
    ]);
    const [left, right] = [
      at(firstSlide(first).overlays, 0),
      at(firstSlide(first).overlays, 1),
    ];
    left.x = 0.01;
    right.x = 0.91;

    const second = compose(
      [{ background: "bg1", assets: ["a1", "a1"], texts: ["Another line"] }],
      {
        previous: first,
      },
    );
    // A plain map keyed by item id loses one of these two, so both x values
    // have to survive, each on its own placement.
    expect(at(firstSlide(second).overlays, 0).x).toBe(0.01);
    expect(at(firstSlide(second).overlays, 1).x).toBe(0.91);
  });

  it("follows an overlay's asset when the assets are reordered", () => {
    const first = compose([{ background: "bg1", assets: ["a1", "a2"], texts: ["Line"] }]);
    const forA1 = at(firstSlide(first).overlays, 0);
    const forA2 = at(firstSlide(first).overlays, 1);
    forA1.x = 0.01;
    forA2.x = 0.91;

    // The same two assets, in the opposite order. Matching by position would
    // hand a1's hand-set geometry to a2, which is exactly how a reordering
    // agent would silently destroy a layout someone adjusted by hand.
    const second = compose(
      [{ background: "bg1", assets: ["a2", "a1"], texts: ["Line"] }],
      {
        previous: first,
      },
    );
    const [firstPlaced, secondPlaced] = [
      at(firstSlide(second).overlays, 0),
      at(firstSlide(second).overlays, 1),
    ];
    expect(firstPlaced.itemId).toBe("a2");
    expect(firstPlaced.x).toBe(0.91);
    expect(firstPlaced.id).toBe(forA2.id);
    expect(secondPlaced.itemId).toBe("a1");
    expect(secondPlaced.x).toBe(0.01);
    expect(secondPlaced.id).toBe(forA1.id);
  });

  it("follows a text's string when the texts are reordered", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["Alpha", "Beta"] }]);
    const forAlpha = at(firstSlide(first).texts, 0);
    const forBeta = at(firstSlide(first).texts, 1);
    forAlpha.y = 0.11;
    forBeta.y = 0.77;

    // The same two strings, in the opposite order.
    const second = compose(
      [{ background: "bg1", assets: [], texts: ["Beta", "Alpha"] }],
      {
        previous: first,
      },
    );
    const [firstPlaced, secondPlaced] = [
      at(firstSlide(second).texts, 0),
      at(firstSlide(second).texts, 1),
    ];
    expect(firstPlaced.text).toBe("Beta");
    expect(firstPlaced.y).toBe(0.77);
    expect(firstPlaced.id).toBe(forBeta.id);
    expect(secondPlaced.text).toBe("Alpha");
    expect(secondPlaced.y).toBe(0.11);
    expect(secondPlaced.id).toBe(forAlpha.id);
  });

  it("tells two texts apart when they differ only in case", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["Ready", "ready"] }]);
    const forUpper = at(firstSlide(first).texts, 0);
    const forLower = at(firstSlide(first).texts, 1);
    forUpper.y = 0.11;
    forLower.y = 0.77;

    // Reordered, so a key that folds case puts both strings in one bucket and
    // then drains it in placement order, handing each text the other's
    // geometry. The match is on the exact string, nothing normalised.
    const second = compose(
      [{ background: "bg1", assets: [], texts: ["ready", "Ready"] }],
      {
        previous: first,
      },
    );
    const [firstPlaced, secondPlaced] = [
      at(firstSlide(second).texts, 0),
      at(firstSlide(second).texts, 1),
    ];
    expect(firstPlaced.text).toBe("ready");
    expect(firstPlaced.y).toBe(0.77);
    expect(firstPlaced.id).toBe(forLower.id);
    expect(secondPlaced.text).toBe("Ready");
    expect(secondPlaced.y).toBe(0.11);
    expect(secondPlaced.id).toBe(forUpper.id);
  });

  it("keeps a hand-placed text when the same string is still on the slide", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["Keep me"] }]);
    const moved = at(firstSlide(first).texts, 0);
    moved.y = 0.13;
    moved.size = 99;
    moved.color = "#FF0000";

    const second = compose([{ background: "bg1", assets: ["a1"], texts: ["Keep me"] }], {
      previous: first,
    });
    const kept = at(firstSlide(second).texts, 0);
    expect(kept.y).toBe(0.13);
    expect(kept.size).toBe(99);
    expect(kept.color).toBe("#FF0000");
    expect(kept.id).toBe(moved.id);
  });

  it("keeps both hand-placed texts when the same string appears twice", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["Twice", "Twice"] }]);
    at(firstSlide(first).texts, 0).y = 0.11;
    at(firstSlide(first).texts, 1).y = 0.77;

    const second = compose(
      [{ background: "bg1", assets: ["a1"], texts: ["Twice", "Twice"] }],
      {
        previous: first,
      },
    );
    expect(at(firstSlide(second).texts, 0).y).toBe(0.11);
    expect(at(firstSlide(second).texts, 1).y).toBe(0.77);
  });

  it("relays out everything when the ratio changes", () => {
    const composition: Composition[] = [
      { background: "bg1", assets: ["a1"], texts: ["Keep me"] },
    ];
    const first = compose(composition);
    at(firstSlide(first).overlays, 0).x = 0.11;
    at(firstSlide(first).texts, 0).y = 0.13;

    const second = compose(composition, { ratio: { w: 1, h: 1 }, previous: first });
    expect(at(firstSlide(second).overlays, 0).x).not.toBe(0.11);
    expect(at(firstSlide(second).overlays, 0).id).not.toBe(
      at(firstSlide(first).overlays, 0).id,
    );
    // The text is back where the lower-third stack puts it.
    expect(at(firstSlide(second).texts, 0).y).toBeGreaterThanOrEqual(0.5);
    // The slide itself is the same slide, only its geometry is new.
    expect(firstSlide(second).id).toBe(firstSlide(first).id);
  });

  it("carries the previous slide's image framing onto the recomposed slide", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["One"] }]);
    Object.assign(firstSlide(first), { imageScale: 1.4, imageX: -0.2, imageY: 0.3 });

    const second = compose([{ background: "bg1", assets: [], texts: ["Two"] }], {
      previous: first,
    });
    expect(firstSlide(second).imageScale).toBe(1.4);
    expect(firstSlide(second).imageX).toBe(-0.2);
    expect(firstSlide(second).imageY).toBe(0.3);
  });

  it("recomposes when the background changes", () => {
    const first = compose([{ background: "bg1", assets: [], texts: ["One"] }]);
    const second = compose([{ background: "bg2", assets: [], texts: ["One"] }], {
      previous: first,
    });
    expect(firstSlide(second)).not.toBe(firstSlide(first));
    expect(firstSlide(second).backgroundItemId).toBe("bg2");
    expect(firstSlide(second).width).toBe(1200);
  });
});

describe("layout", () => {
  it("stacks texts in the lower third", () => {
    const doc = compose([{ background: "bg1", assets: [], texts: ["One", "Two"] }]);
    for (const text of firstSlide(doc).texts) {
      expect(text.y).toBeGreaterThanOrEqual(0.5);
      expect(text.x).toBe(SIDE_MARGIN);
    }
  });

  it("never lets an asset overlap the text block", () => {
    const doc = compose([
      {
        background: "bg1",
        assets: ["a1", "a2", "a3", "a4"],
        texts: ["One", "Two", "Three"],
      },
    ]);
    const slide = firstSlide(doc);
    const assetBottom = Math.max(
      ...slide.overlays.map((overlay) => overlay.y + (overlay.height ?? 0)),
    );
    const textTop = Math.min(...slide.texts.map((text) => text.y));
    expect(assetBottom).toBeLessThanOrEqual(textTop);
  });

  it("centres a partial last asset row", () => {
    const doc = compose([
      { background: "bg1", assets: ["a1", "a2", "a3", "a4"], texts: ["One"] },
    ]);
    const last = at(firstSlide(doc).overlays, 3);
    expect(last.x + last.width / 2).toBeCloseTo(0.5, 10);
    // The lone item keeps the size a full row would have given it.
    const firstOfRow = at(firstSlide(doc).overlays, 0);
    expect(last.width).toBeCloseTo(firstOfRow.width, 10);
  });

  it("starts the first asset row at the top margin", () => {
    const doc = compose([{ background: "bg1", assets: ["a3"], texts: [] }]);
    expect(at(firstSlide(doc).overlays, 0).y).toBeCloseTo(ASSET_TOP_MARGIN, 10);
  });

  it("numbers overlays before texts", () => {
    const doc = compose([
      { background: "bg1", assets: ["a1", "a2"], texts: ["One", "Two"] },
    ]);
    const slide = firstSlide(doc);
    expect(slide.overlays.map((overlay) => overlay.z)).toEqual([1, 2]);
    expect(slide.texts.map((text) => text.z)).toEqual([3, 4]);
  });

  it("scales an unfittable text block down instead of running it off the slide", () => {
    const line =
      "A long line that wraps a great many times before it fits the content width";
    const texts = Array.from({ length: 40 }, (_, index) => `${index} ${line}`);
    const slide = firstSlide(compose([{ background: "bg1", assets: [], texts }]));
    expect(slide.texts).toHaveLength(40);
    for (const text of slide.texts) {
      expect(text.size).toBeGreaterThanOrEqual(TEXT_SIZE_FLOOR);
    }
    expect(at(slide.texts, 0).y).toBeGreaterThanOrEqual(TEXT_TOP_LIMIT);
  });
});

describe("the composition shorthand", () => {
  it("drops empty entries and accepts a bare string", () => {
    const doc = compose([
      // The agent may send a single value where the schema promises a list, so
      // normalizeList wraps it. The cast reproduces that untyped input.
      { background: "bg1", assets: "a1" as unknown as string[], texts: ["", "Kept"] },
    ]);
    const slide = firstSlide(doc);
    expect(slide.overlays.map((overlay) => overlay.itemId)).toEqual(["a1"]);
    expect(slide.texts.map((text) => text.text)).toEqual(["Kept"]);
  });

  it("names an unnamed slide by its position and truncates a long name", () => {
    const doc = compose([
      { background: "bg1" },
      { background: "bg1", name: "x".repeat(200) },
    ]);
    expect(at(doc.slides, 0).name).toBe("Slide 1");
    expect(at(doc.slides, 1).name).toHaveLength(120);
  });

  it("falls back to the default ratio when the ratio is missing or unusable", () => {
    expect(
      composeDocument({ ratio: undefined, slides: [], library, newId }).ratio,
    ).toEqual({
      w: 9,
      h: 16,
    });
    expect(compose([], { ratio: { w: 0, h: 16 } }).ratio).toEqual({ w: 9, h: 16 });
  });

  it("generates ids without an injected generator", () => {
    const doc = composeDocument({
      ratio: PORTRAIT,
      slides: [{ background: "bg1", assets: ["a1"], texts: ["One"] }],
      library,
    });
    expect(firstSlide(doc).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reduces a document back to the shorthand, in z order", () => {
    const doc = compose([
      { background: "bg1", assets: ["a1", "a2"], texts: ["One", "Two"] },
    ]);
    const slide = firstSlide(doc);
    // Re-ordering by z, not by array position, is what toComposition promises.
    slide.overlays.reverse();
    slide.texts.reverse();
    const shorthand = toComposition({ id: "p1", name: "Deck", version: 3, ...doc });
    expect(shorthand).toEqual({
      id: "p1",
      name: "Deck",
      version: 3,
      ratio: { w: 9, h: 16 },
      slides: [
        {
          name: "Slide 1",
          background: "bg1",
          assets: ["a1", "a2"],
          texts: ["One", "Two"],
        },
      ],
    });
  });
});

describe("validation", () => {
  it("rejects a slideshow with no slides", () => {
    expect(() => validateComposition([])).toThrow(ComposeError);
    expect(() => validateComposition("not a list")).toThrow(ComposeError);
  });

  it("rejects more than a hundred slides", () => {
    const slides = Array.from({ length: 101 }, () => ({ background: "bg1" }));
    expect(() => validateComposition(slides)).toThrow(/at most 100 slides/);
    expect(validateComposition(slides.slice(0, 100))).toHaveLength(100);
  });

  it("rejects a slide with no background", () => {
    expect(() => validateComposition([{ texts: ["One"] }])).toThrow(/needs a background/);
    expect(() => validateComposition([null])).toThrow(/is not an object/);
  });

  it("rejects a ratio outside 0.4 to 2.5", () => {
    expect(() => compose([{ background: "bg1" }], { ratio: { w: 1, h: 3 } })).toThrow(
      ComposeError,
    );
    expect(() => compose([{ background: "bg1" }], { ratio: { w: 3, h: 1 } })).toThrow(
      /between 0.4:1 and 2.5:1/,
    );
    // The edges themselves are legal.
    expect(compose([{ background: "bg1" }], { ratio: { w: 2.5, h: 1 } }).ratio).toEqual({
      w: 2.5,
      h: 1,
    });
  });
});
