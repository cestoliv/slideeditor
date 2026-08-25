import { expect, it } from "vitest";
import { TEXT_FONT_FAMILY, TEXT_FONT_STACK, textFontString } from "./constants.js";

it("builds the canvas font shorthand both callers must bind", () => {
  // Byte for byte what app.js:2739 and app.js:4449 build today. A measurer bound
  // to a different string rewraps every line, and nothing else in this module
  // can see that, so the string is pinned here.
  expect(textFontString(48)).toBe('500 48px "TikTok Sans"');
});

it("names one family for measuring and one stack for declaring", () => {
  expect(TEXT_FONT_FAMILY).toBe("TikTok Sans");
  expect(TEXT_FONT_STACK).toBe('"TikTok Sans", sans-serif');
});
