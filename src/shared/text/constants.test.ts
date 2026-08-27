import { expect, it } from "vitest";
import { DEFAULT_FONT_FAMILY, fontStack, textFontString } from "./constants.js";

it("builds the canvas font shorthand for whatever family the caller names", () => {
  // Byte for byte what app.js:2739 and app.js:4449 built for the one family
  // they knew about; every caller now has to say which one it means.
  expect(textFontString(48, "TikTok Sans")).toBe('500 48px "TikTok Sans"');
  expect(textFontString(48, "Space Mono")).toBe('500 48px "Space Mono"');
});

it("accepts an explicit weight for a family whose real weight differs from TEXT_WEIGHT", () => {
  // A Google family can be catalogued at a weight other than TEXT_WEIGHT
  // (src/web/app/fontFaces.ts weightFor). Callers that know the real weight
  // pass it here rather than the string silently defaulting to TEXT_WEIGHT.
  expect(textFontString(48, "Space Mono", 400)).toBe('400 48px "Space Mono"');
});

it("names the default family and builds a fallback stack for any family", () => {
  expect(DEFAULT_FONT_FAMILY).toBe("TikTok Sans");
  expect(fontStack("Space Mono")).toBe('"Space Mono", sans-serif');
});
