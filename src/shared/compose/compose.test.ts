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
  CONTENT_WIDTH,
  SIDE_MARGIN,
  TEXT_BOTTOM_MARGIN,
  TEXT_TOP_LIMIT,
} from "./constants.js";
import { DESIGN_WIDTH } from "../geometry/index.js";
import { DEFAULT_ADVANCE_RATIO } from "../text/index.js";
import { BUILTIN_DEFAULTS } from "../schema/index.js";
import type { AccountDefaults } from "../schema/index.js";

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
  options: {
    ratio?: { w: number; h: number };
    previous?: SlideDocument | null;
    defaults?: AccountDefaults;
    advanceRatioFor?: (family: string) => number;
  } = {},
): SlideDocument {
  return composeDocument({
    ratio: options.ratio ?? PORTRAIT,
    slides,
    library,
    previous: options.previous ?? null,
    newId,
    defaults: options.defaults ?? BUILTIN_DEFAULTS,
    advanceRatioFor: options.advanceRatioFor,
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

  /*
   * Finding 10: layoutTexts had no font file to measure a family's average
   * glyph width against, so it read a shared, name-keyed constant with only
   * two entries. composeDocument now takes an `advanceRatioFor` a caller
   * with a real font catalogue (server/services/fonts.ts's FontService) can
   * inject — this is what proves it actually reaches layoutTexts, by giving
   * the exact same string a wider "measured" advance and checking the
   * resulting block is taller, rather than the fixed, name-keyed value
   * every input got before.
   */
  it("uses an injected advanceRatioFor for the line-wrap estimate", () => {
    const line = "word ".repeat(30).trim();
    const narrow = firstSlide(
      compose([{ background: "bg1", assets: [], texts: [line] }], {
        advanceRatioFor: () => 0.3,
      }),
    ).texts[0]!;
    const wide = firstSlide(
      compose([{ background: "bg1", assets: [], texts: [line] }], {
        advanceRatioFor: () => 0.8,
      }),
    ).texts[0]!;
    // A wider average glyph fits fewer characters per line, so the same
    // string wraps to more lines and a taller box.
    expect(wide.height).toBeGreaterThan(narrow.height);
  });

  it("falls back to the shared, name-keyed default when no advanceRatioFor is injected", () => {
    const line = "word ".repeat(30).trim();
    const withoutInjection = firstSlide(
      compose([{ background: "bg1", assets: [], texts: [line] }]),
    ).texts[0]!;
    const withDefaultExplicitly = firstSlide(
      compose([{ background: "bg1", assets: [], texts: [line] }], {
        advanceRatioFor: () => DEFAULT_ADVANCE_RATIO,
      }),
    ).texts[0]!;
    expect(withoutInjection.height).toBe(withDefaultExplicitly.height);
  });

  it("uses the account's text size for every layer, with no shrinking", () => {
    const custom: AccountDefaults = {
      ...BUILTIN_DEFAULTS,
      text: { ...BUILTIN_DEFAULTS.text, size: 40 },
    };
    const doc = compose([{ background: "bg1", assets: [], texts: ["One", "Two"] }], {
      defaults: custom,
    });
    for (const text of firstSlide(doc).texts) {
      expect(text.size).toBe(40);
    }
  });

  it("centers an unfittable text block rather than shrinking or flooring it to one edge", () => {
    const line =
      "A long line that wraps a great many times before it fits the content width";
    const texts = Array.from({ length: 40 }, (_, index) => `${index} ${line}`);
    const slide = firstSlide(compose([{ background: "bg1", assets: [], texts }]));
    expect(slide.texts).toHaveLength(40);
    for (const text of slide.texts) {
      expect(text.size).toBe(BUILTIN_DEFAULTS.text.size);
    }
    /*
     * Forty long lines at 64px cannot fit under TEXT_BLOCK_MAX at either gap.
     * Size stays fixed — there is no smaller rung to fall back to — so the
     * block runs off the frame either way. Flooring it at TEXT_TOP_LIMIT (the
     * previous behaviour) dumped the whole overflow on the bottom edge, which
     * on a 9:16 slide is where a platform's caption and action chrome sit —
     * the worse edge to lose. Centering it on the frame instead spreads the
     * overflow evenly: the first line starts as far above y = 0 as the last
     * line ends below y = 1.
     */
    const first = at(slide.texts, 0);
    const last = at(slide.texts, slide.texts.length - 1);
    const overflowTop = -first.y;
    const overflowBottom = last.y + last.height - 1;
    expect(overflowTop).toBeGreaterThan(0);
    expect(overflowBottom).toBeCloseTo(overflowTop, 10);
    // And it still starts well above where an unfittable block used to be
    // floored, rather than being squeezed entirely below it.
    expect(first.y).toBeLessThan(TEXT_TOP_LIMIT);
  });

  /*
   * Finding 4 (fix round 3): a block whose total height lands in (0.90, 1.0)
   * at these constants fits the frame just fine — bottom-anchoring it and
   * flooring the top at TEXT_TOP_LIMIT never has to push the top above that
   * limit — but the centering branch above used to fire for it anyway,
   * because `fits` compared `total` against
   * `1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT` (0.90) rather than against 1.
   * Centering shifts the whole block toward the frame's middle regardless of
   * how small the top-limit shortfall actually is, so it slides the block
   * DOWN into the reserved bottom margin — the exact chrome zone flooring
   * exists to protect — while wasting the top space bottom-anchoring would
   * have kept clear. Every total in that band was worse off than before, and
   * untested: the golden fixture and the "centers an unfittable block" test
   * above both sit above 1.0.
   *
   * charsPerLine mirrors textHeight()'s own formula (compose.ts) rather than
   * a hardcoded line width, so a tuned constant does not silently desync
   * this from what layoutTexts actually wraps at.
   */
  const charsPerLine = Math.max(
    8,
    Math.floor((CONTENT_WIDTH * DESIGN_WIDTH) / (BUILTIN_DEFAULTS.text.size * 0.5)),
  );

  /** A composition text guaranteed to wrap to exactly `lines` lines at charsPerLine. */
  function lineText(lines: number): string {
    return "x".repeat(charsPerLine * (lines - 1) + 1);
  }

  /**
   * A stack of `texts.length` texts whose lines sum to `lineCounts`, so the
   * block's total height is controlled by both dimensions layoutTexts' gap
   * math depends on (line count, which sets each box's height, and text
   * count, which sets how many gaps are summed) — finer control than
   * varying text count alone, which only moves in whole extra-line-plus-gap
   * steps too coarse to land close to a specific boundary.
   */
  function stackOfLineCounts(lineCounts: number[]): string[] {
    return lineCounts.map(lineText);
  }

  function measuredBlock(texts: string[]): {
    first: Slide["texts"][number];
    total: number;
  } {
    const slide = firstSlide(compose([{ background: "bg1", assets: [], texts }]));
    const first = at(slide.texts, 0);
    const last = at(slide.texts, slide.texts.length - 1);
    return { first, total: last.y + last.height - first.y };
  }

  it("floors, rather than centers, a text block whose total sits well inside (0.90, 1.0)", () => {
    // 20 single-line texts: comfortably inside the band per this file's own
    // constants (verified in the repro this fix shipped with).
    const { first, total } = measuredBlock(stackOfLineCounts(Array(20).fill(1)));
    expect(
      total,
      "picks a block inside the band this regression is about",
    ).toBeGreaterThan(1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT);
    expect(total).toBeLessThan(1);
    // Floored at TEXT_TOP_LIMIT: bottom-anchoring only needed the top pushed
    // down by (1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT - total, negated) —
    // a small amount — never centered on the whole frame.
    expect(first.y).toBeCloseTo(TEXT_TOP_LIMIT, 10);
    // The regression this guards: centering would have placed first.y at
    // (1 - total) / 2, well below the top limit for a total this large.
    expect(first.y).not.toBeCloseTo((1 - total) / 2, 2);
  });

  it("still floors, not centers, a text block right at the edge of the band, just above 0.90", () => {
    // 14 single-line texts plus 3 two-line texts: 20 lines total across 17
    // texts, landing just over the old (wrong) 0.90 threshold — see this
    // file's own comment above for why text count, not just line count,
    // has to be tuned to land this close.
    const { first, total } = measuredBlock(
      stackOfLineCounts([...Array(14).fill(1), 2, 2, 2]),
    );
    const oldThreshold = 1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT;
    expect(
      total,
      "lands just past the old threshold, not deep in the band",
    ).toBeGreaterThan(oldThreshold);
    expect(total).toBeLessThan(oldThreshold + 0.02);
    expect(first.y).toBeCloseTo(TEXT_TOP_LIMIT, 10);
  });

  it("centers a text block right at the edge of the band, just above 1.0", () => {
    // 22 single-line texts lands just over a total of 1 at these constants.
    const { first, total } = measuredBlock(stackOfLineCounts(Array(22).fill(1)));
    expect(total, "picks a block just past the frame's own height").toBeGreaterThan(1);
    expect(total).toBeLessThan(1.1);
    // Centered, not floored: the top overflows past y = 0 by the same
    // amount the bottom overflows past y = 1.
    expect(first.y).toBeCloseTo((1 - total) / 2, 10);
    expect(first.y).toBeLessThan(0);
  });

  /*
   * Finding 3 (fix round 4): the `total > 1` guard above was the wrong
   * boundary. Flooring the top at TEXT_TOP_LIMIT only avoids clipping when
   * the block's bottom (TEXT_TOP_LIMIT + total) stays at or under 1 — that
   * is, when `total <= 1 - TEXT_TOP_LIMIT`. Every total in
   * `(1 - TEXT_TOP_LIMIT, 1]` used to get floored anyway, running the bottom
   * past y = 1 and clipping text off the slide while leaving the headroom
   * flooring was supposed to use sitting unused above it — the exact outcome
   * centering exists to prevent. The four tests below sit inside that band
   * (approximated here, at these constants, as (0.96, 1.0]) and either side
   * of the corrected `1 - TEXT_TOP_LIMIT` (0.98) threshold, none of which the
   * three tests above cover (0.9367, 0.9067 and 1.0313 respectively).
   */
  it("still floors, not centers, a text block just above 0.96, below the corrected threshold", () => {
    // 17 single-line texts plus 2 two-line texts: lands just past 0.96 but
    // still under 1 - TEXT_TOP_LIMIT, so flooring places it without clipping.
    const { first, total } = measuredBlock(
      stackOfLineCounts([...Array(17).fill(1), 2, 2]),
    );
    expect(total, "lands in the band this fix covers").toBeGreaterThan(0.96);
    expect(total).toBeLessThan(1 - TEXT_TOP_LIMIT);
    expect(first.y).toBeCloseTo(TEXT_TOP_LIMIT, 10);
    // Floored, and not clipped: the bottom stays at or above the frame edge.
    expect(first.y + total).toBeLessThanOrEqual(1);
  });

  it("centers, not floors, a text block just past the corrected 1 - TEXT_TOP_LIMIT threshold", () => {
    // 12 single-line texts plus 5 two-line texts: lands just past the fixed
    // threshold. The old `total > 1` guard floored this instead, and
    // flooring at TEXT_TOP_LIMIT then ran the block's bottom past y = 1.
    const { first, total } = measuredBlock(
      stackOfLineCounts([...Array(12).fill(1), 2, 2, 2, 2, 2]),
    );
    expect(total).toBeGreaterThan(1 - TEXT_TOP_LIMIT);
    expect(total).toBeLessThan(1);
    expect(first.y).toBeCloseTo((1 - total) / 2, 10);
    // Not clipped: centering keeps the bottom at or under the frame edge —
    // the old guard put it at TEXT_TOP_LIMIT + total, past 1, here.
    expect(first.y + total).toBeLessThanOrEqual(1);
  });

  it("does not clip 21 single-line texts on a 9:16 slide (this fix's own reproduction)", () => {
    // The exact case this fix was written against: total lands at 0.984,
    // inside the regression band. The old guard floored it at TEXT_TOP_LIMIT
    // (0.02), running the bottom to 1.004 — 0.004 of the last line clipped
    // off the slide while 0.02 of headroom sat unused at the top.
    const { first, total } = measuredBlock(stackOfLineCounts(Array(21).fill(1)));
    expect(total).toBeCloseTo(0.984, 3);
    expect(first.y).toBeCloseTo((1 - total) / 2, 10);
    expect(first.y + total).toBeLessThanOrEqual(1);
  });

  it("centers a text block just above 1.0, at the closed edge of the band", () => {
    // 16 single-line texts plus 3 two-line texts: lands just over a total of
    // 1, closer to that boundary than the "just above 1.0" test above.
    const { first, total } = measuredBlock(
      stackOfLineCounts([...Array(16).fill(1), 2, 2, 2]),
    );
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThan(1.01);
    expect(first.y).toBeCloseTo((1 - total) / 2, 10);
    expect(first.y).toBeLessThan(0);
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
      composeDocument({
        ratio: undefined,
        slides: [],
        library,
        newId,
        defaults: BUILTIN_DEFAULTS,
      }).ratio,
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
      defaults: BUILTIN_DEFAULTS,
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
  const context = { accountId: "default", lookupItem: () => null };

  it("rejects a slideshow with no slides", () => {
    expect(() => validateComposition([], context)).toThrow(ComposeError);
    expect(() =>
      validateComposition("not a list" as unknown as Composition[], context),
    ).toThrow(ComposeError);
  });

  it("rejects more than a hundred slides", () => {
    const slides = Array.from({ length: 101 }, () => ({ background: "bg1" }));
    expect(() => validateComposition(slides, context)).toThrow(/at most 100 slides/);
    expect(() => validateComposition(slides.slice(0, 100), context)).not.toThrow();
  });

  it("rejects a slide with no background", () => {
    expect(() =>
      validateComposition([{ texts: ["One"] } as Composition], context),
    ).toThrow(/needs a background/);
    expect(() => validateComposition([null as unknown as Composition], context)).toThrow(
      /is not an object/,
    );
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
