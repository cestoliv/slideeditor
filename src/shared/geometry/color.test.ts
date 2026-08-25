import { expect, it } from "vitest";
import {
  ensureBoxedTextContrast,
  formatRgb,
  hexToRgb,
  normalizeHexColor,
  outlineColorFor,
  rgbToHex,
  TEXT_COLOR_PRESETS,
  textColorOf,
} from "./color.js";

it("accepts a hex colour with or without the hash and upper-cases it", () => {
  expect(normalizeHexColor("fe2c55")).toBe("#FE2C55");
  expect(normalizeHexColor("#FE2C55")).toBe("#FE2C55");
  expect(normalizeHexColor("nope", "#FFFFFF")).toBe("#FFFFFF");
});

it("expands the three digit form and trims the input", () => {
  expect(normalizeHexColor("  #f0a  ")).toBe("#FF00AA");
  expect(normalizeHexColor("f0a")).toBe("#FF00AA");
});

it("returns null for a bad colour when the caller offers no fallback", () => {
  expect(normalizeHexColor("")).toBeNull();
  expect(normalizeHexColor(null)).toBeNull();
  expect(normalizeHexColor("#12345")).toBeNull();
  expect(normalizeHexColor("#12345g")).toBeNull();
});

it("outlines a light colour in black and a dark colour in white", () => {
  expect(outlineColorFor("#FFFFFF")).toBe("#111111");
  expect(outlineColorFor("#111111")).toBe("#FFFFFF");
  // Green weighs most in the luminance sum, so it flips where red does not.
  expect(outlineColorFor("#00FF00")).toBe("#111111");
  expect(outlineColorFor("#FF0000")).toBe("#FFFFFF");
});

// app.js:257 returns the CSS function, not the bare channels the brief quotes.
// Its only readers are the inspector's RGB field (app.js:2029, app.js:2385,
// app.js:2422) and the copy button beside it (app.js:2427), so the wrapper is
// what the user reads and copies.
it("formats a hex colour as a CSS rgb string", () => {
  expect(formatRgb("#FE2C55")).toBe("rgb(254, 44, 85)");
  expect(formatRgb("nonsense")).toBe("rgb(255, 255, 255)");
});

it("splits a hex colour into channels", () => {
  expect(hexToRgb("#FE2C55")).toEqual({ r: 254, g: 44, b: 85 });
  expect(hexToRgb(undefined)).toEqual({ r: 255, g: 255, b: 255 });
});

it("reads a CSS rgb string back as hex", () => {
  expect(rgbToHex("rgb(254, 44, 85)")).toBe("#FE2C55");
  expect(rgbToHex("254 44 85")).toBe("#FE2C55");
  expect(rgbToHex("rgb(300, -20, 85.6)")).toBe("#FF0056");
  expect(rgbToHex("rgba(1, 2, 3, 0.5)")).toBeNull();
  expect(rgbToHex("red")).toBeNull();
  expect(rgbToHex(null)).toBeNull();
});

it("defaults a boxed text on a light pill to dark ink", () => {
  expect(textColorOf({ style: "boxed", background: "white", color: "" })).toBe("#111111");
  expect(textColorOf({ style: "boxed", background: "black", color: "" })).toBe("#FFFFFF");
  expect(textColorOf({ style: "plain", color: "" })).toBe("#FFFFFF");
  expect(textColorOf({ style: "boxed", background: "white", color: "#FFE45E" })).toBe(
    "#FFE45E",
  );
});

it("flips white text on a white pill to black", () => {
  const text = ensureBoxedTextContrast({
    style: "boxed" as const,
    background: "white" as const,
    color: "#FFFFFF",
  });
  expect(text.color).toBe("#111111");
});

it("flips black text on a black pill to white", () => {
  const text = ensureBoxedTextContrast({
    style: "boxed" as const,
    background: "black" as const,
    color: "#111111",
  });
  expect(text.color).toBe("#FFFFFF");
});

it("returns the same layer when the contrast already holds", () => {
  const readable = {
    style: "boxed" as const,
    background: "white" as const,
    color: "#FE2C55",
  };
  expect(ensureBoxedTextContrast(readable)).toBe(readable);
  const plain = { style: "plain" as const, color: "#FFFFFF" };
  expect(ensureBoxedTextContrast(plain)).toBe(plain);
});

it("offers only valid hex presets", () => {
  expect(TEXT_COLOR_PRESETS).toHaveLength(8);
  for (const preset of TEXT_COLOR_PRESETS) {
    expect(normalizeHexColor(preset.value), preset.name).toBe(preset.value);
  }
});
