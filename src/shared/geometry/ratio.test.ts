import { describe, expect, it } from "vitest";
import {
  CUSTOM_RATIO_MAX,
  normalizeRatio,
  thumbnailHeight,
  THUMBNAIL_WIDTH,
  CUSTOM_RATIO_MIN,
  isInstagramSafeRatio,
  isRatioInCustomBand,
  outputAspect,
  outputHeight,
  OUTPUT_WIDTH,
  RATIO_PRESETS,
  ratioLabel,
  sameRatio,
  suggestedChrome,
} from "./ratio.js";

it("rounds the output height to an even number", () => {
  expect(outputHeight({ w: 9, h: 16 })).toBe(1920);
  expect(outputHeight({ w: 4, h: 5 })).toBe(1350);
  expect(outputHeight({ w: 1, h: 1 })).toBe(1080);
  expect(outputHeight({ w: 1.91, h: 1 })).toBe(566);
});

describe("even output heights", () => {
  it("returns an even height for every preset", () => {
    for (const preset of RATIO_PRESETS) {
      const height = outputHeight(preset);
      expect(height % 2, preset.label).toBe(0);
      expect(height).toBeGreaterThanOrEqual(2);
    }
  });

  // A seeded generator, so a failure here is a failure anyone can reproduce.
  it("returns an even height across the legal custom band", () => {
    let seed = 20260824;
    for (let index = 0; index < 500; index += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const value =
        CUSTOM_RATIO_MIN + (seed / 2147483648) * (CUSTOM_RATIO_MAX - CUSTOM_RATIO_MIN);
      const height = outputHeight({ w: value, h: 1 });
      expect(height % 2, `ratio ${value}`).toBe(0);
      expect(height).toBeGreaterThanOrEqual(2);
    }
  });

  it("never returns zero for a ratio far wider than the band", () => {
    expect(outputHeight({ w: 100000, h: 1 })).toBe(2);
  });
});

it("reports the aspect of the rounded canvas, not of the raw ratio", () => {
  expect(outputAspect({ w: 9, h: 16 })).toBe(OUTPUT_WIDTH / 1920);
  // 1080 / 1.91 lands on 565.4, so the canvas is 566 tall and the aspect
  // follows the pixels rather than the typed number.
  expect(outputAspect({ w: 1.91, h: 1 })).toBe(OUTPUT_WIDTH / 566);
});

it("labels a preset ratio by its name", () => {
  expect(ratioLabel({ w: 9, h: 16 })).toBe("9:16");
  expect(ratioLabel({ w: 18, h: 32 })).toBe("9:16");
});

it("labels a custom ratio by its numbers, trimmed to two decimals", () => {
  expect(ratioLabel({ w: 2.5, h: 1 })).toBe("2.5:1");
  expect(ratioLabel({ w: 1.333333, h: 1.5 })).toBe("1.33:1.5");
});

it("treats ratios within a rounding step as the same", () => {
  expect(sameRatio({ w: 9, h: 16 }, { w: 18, h: 32 })).toBe(true);
  expect(sameRatio({ w: 9, h: 16 }, { w: 4, h: 5 })).toBe(false);
});

it("accepts only Instagram's supported ratio band", () => {
  expect(isInstagramSafeRatio({ w: 4, h: 5 })).toBe(true);
  expect(isInstagramSafeRatio({ w: 3, h: 4 })).toBe(true);
  expect(isInstagramSafeRatio({ w: 1.91, h: 1 })).toBe(true);
  expect(isInstagramSafeRatio({ w: 9, h: 16 })).toBe(false);
  expect(isInstagramSafeRatio({ w: 2, h: 1 })).toBe(false);
});

it("allows a wider custom band than Instagram accepts", () => {
  expect(isRatioInCustomBand({ w: 9, h: 16 })).toBe(true);
  expect(isRatioInCustomBand({ w: 1, h: 3 })).toBe(false);
  expect(isRatioInCustomBand({ w: 3, h: 1 })).toBe(false);
});

it("suggests TikTok's chrome only for a tall canvas", () => {
  expect(suggestedChrome({ w: 9, h: 16 })).toBe("tiktok");
  expect(suggestedChrome({ w: 4, h: 5 })).toBe("instagram-feed");
});

it("rounds a thumbnail height to an even number too", () => {
  expect(thumbnailHeight({ w: 9, h: 16 })).toBe(960);
  expect(thumbnailHeight({ w: 1, h: 1 })).toBe(540);
  // Both heights round to even on their own, so a thumbnail is near enough
  // half the export and not exactly half. 1350 and 566 both round up here.
  expect(thumbnailHeight({ w: 4, h: 5 })).toBe(676);
  expect(thumbnailHeight({ w: 1.91, h: 1 })).toBe(284);
  for (const preset of RATIO_PRESETS) {
    const height = thumbnailHeight(preset);
    expect(height % 2, preset.label).toBe(0);
    expect(height).toBeGreaterThanOrEqual(2);
  }
  expect(THUMBNAIL_WIDTH / OUTPUT_WIDTH).toBe(0.5);
});

it("repairs a ratio that never went through the schema", () => {
  expect(normalizeRatio({ w: 4, h: 5 })).toEqual({ w: 4, h: 5 });
  expect(normalizeRatio({ w: 0, h: 5 })).toEqual({ w: 9, h: 16 });
  expect(normalizeRatio({ w: -4, h: 5 })).toEqual({ w: 9, h: 16 });
  expect(normalizeRatio({ w: Number.NaN, h: 5 })).toEqual({ w: 9, h: 16 });
  expect(normalizeRatio({ w: Number.POSITIVE_INFINITY, h: 5 })).toEqual({ w: 9, h: 16 });
  expect(normalizeRatio({})).toEqual({ w: 9, h: 16 });
  expect(normalizeRatio(null)).toEqual({ w: 9, h: 16 });
  // The repaired ratio is a copy, so a caller cannot write through it.
  const first = normalizeRatio(null);
  first.w = 1;
  expect(normalizeRatio(null).w).toBe(9);
});
