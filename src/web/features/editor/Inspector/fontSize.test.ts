import { describe, expect, it } from "vitest";
import {
  FONT_SIZE_SLIDER_MAX,
  FONT_SIZE_SLIDER_STEP,
  clampFontSize,
  fontSizeFromSliderPosition,
  formatFontSize,
  sliderPositionFromFontSize,
} from "./fontSize.js";

/*
 * 48 is here because the other five land on exact multiples of ten before any
 * rounding (0, 220, 780, 880, 1000), so a step test built only from them cannot
 * see the rounding it is named for. 48 interpolates to 369.33.
 */
const SIZES = [20, 40, 48, 70, 120, 180];

describe("the font size slider", () => {
  it("maps the ends of the slider to the size limits", () => {
    expect(fontSizeFromSliderPosition(0)).toBe(20);
    expect(fontSizeFromSliderPosition(FONT_SIZE_SLIDER_MAX)).toBe(180);
  });

  it("round-trips a size through the slider position", () => {
    for (const size of SIZES) {
      expect(fontSizeFromSliderPosition(sliderPositionFromFontSize(size))).toBe(size);
    }
  });

  it("gives more travel to the small sizes", () => {
    const middle = fontSizeFromSliderPosition(FONT_SIZE_SLIDER_MAX / 2);
    expect(middle - 40).toBeLessThan(180 - middle);
  });

  /*
   * The test above passes against a plain linear map, which is the whole point
   * of the four stops. Half the travel has to spend itself inside the bottom
   * third of the range, which a linear map (100 at the midpoint) cannot do.
   */
  it("spends half the travel inside the bottom third of the range", () => {
    expect(fontSizeFromSliderPosition(FONT_SIZE_SLIDER_MAX / 2)).toBeLessThan(
      20 + (180 - 20) / 3,
    );
  });

  it("rises without ever going back down", () => {
    let previous = fontSizeFromSliderPosition(0);
    for (
      let position = FONT_SIZE_SLIDER_STEP;
      position <= FONT_SIZE_SLIDER_MAX;
      position += FONT_SIZE_SLIDER_STEP
    ) {
      const size = fontSizeFromSliderPosition(position);
      expect(size).toBeGreaterThan(previous);
      previous = size;
    }
  });

  it("holds a position on the slider's own step", () => {
    for (const size of SIZES) {
      expect(sliderPositionFromFontSize(size) % FONT_SIZE_SLIDER_STEP).toBe(0);
    }
  });

  /* app.js:1908-1910 bounds the input before it interpolates. */
  it("pins anything off the ends to the ends", () => {
    expect(fontSizeFromSliderPosition(-500)).toBe(20);
    expect(fontSizeFromSliderPosition(9999)).toBe(180);
    expect(fontSizeFromSliderPosition(Number.NaN)).toBe(20);
    expect(sliderPositionFromFontSize(4)).toBe(0);
    expect(sliderPositionFromFontSize(4000)).toBe(FONT_SIZE_SLIDER_MAX);
  });

  /* app.js:1929. Sizes land on the half pixel, never anywhere finer. */
  it("lands every size on a half pixel", () => {
    for (let position = 0; position <= FONT_SIZE_SLIDER_MAX; position += 10) {
      const size = fontSizeFromSliderPosition(position);
      expect(size * 2).toBe(Math.round(size * 2));
    }
  });
});

describe("the typed font size", () => {
  /* app.js:2360. A blank or unreadable box falls back to the minimum, not to zero. */
  it("clamps a typed size and reads a blank box as the minimum", () => {
    expect(clampFontSize("64")).toBe(64);
    expect(clampFontSize("64.3")).toBe(64.5);
    expect(clampFontSize("")).toBe(20);
    expect(clampFontSize("what")).toBe(20);
    expect(clampFontSize("0")).toBe(20);
    expect(clampFontSize(500)).toBe(180);
    expect(clampFontSize(-500)).toBe(20);
  });

  /* app.js:1928-1931. A whole number shows no decimal, a half shows one. */
  it("writes a whole size without a decimal and a half size with one", () => {
    expect(formatFontSize(48)).toBe("48");
    expect(formatFontSize(48.5)).toBe("48.5");
    expect(formatFontSize(48.3)).toBe("48.5");
  });
});
