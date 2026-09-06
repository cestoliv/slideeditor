import { clamp } from "./math.js";

export interface ColorPreset {
  name: string;
  value: string;
}

/** The swatches the text colour picker offers (app.js:53-62). */
export const TEXT_COLOR_PRESETS: readonly ColorPreset[] = [
  { name: "White", value: "#FFFFFF" },
  { name: "Black", value: "#111111" },
  { name: "Yellow", value: "#FFE45E" },
  { name: "Pink", value: "#FE2C55" },
  { name: "Cyan", value: "#25F4EE" },
  { name: "Blue", value: "#4D7CFE" },
  { name: "Green", value: "#35D07F" },
  { name: "Purple", value: "#A855F7" },
];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A text layer far enough along to have a colour, including a legacy one with
 * none. The unions are spelled out rather than taken from TextLayer, because
 * textLayerSchema calls textColorOf in its own transform and the inference
 * would chase its own tail.
 */
export interface TextColorSource {
  style?: "plain" | "outline" | "boxed";
  /** A hex colour, already normalized by the time anything here sees it. */
  background?: string;
  color?: string;
}

/**
 * Accepts a hex colour with or without the hash, expands the 3-digit form, and
 * upper-cases it (app.js:226-230). Anything else falls back, and the fallback
 * is null unless the caller supplies one, so a caller can tell a bad colour
 * from a good one.
 */
export function normalizeHexColor(
  value: string | null | undefined,
  fallback: string,
): string;
export function normalizeHexColor(
  value: string | null | undefined,
  fallback?: null,
): string | null;
export function normalizeHexColor(
  value: string | null | undefined,
  fallback: string | null = null,
): string | null {
  let hex = String(value ?? "")
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    hex = hex
      .split("")
      .map((character) => character + character)
      .join("");
  }
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : fallback;
}

/**
 * Widens the two legacy tone names into the hex colours they always rendered
 * as. This is the only place in the codebase that still understands "white"
 * and "black" as background values; textBackgroundSchema and
 * accountDefaultsSchema both normalize through this on the way in, so nothing
 * downstream ever reads a tone again, only a colour.
 */
export function normalizeTextBackground(value: string | null | undefined): string {
  const tone = String(value ?? "")
    .trim()
    .toLowerCase();
  if (tone === "white") return "#FFFFFF";
  if (tone === "black") return "#111111";
  return normalizeHexColor(value, "#FFFFFF");
}

/**
 * The colour a text renders in (app.js:232-235). A boxed text on anything but a
 * black box defaults to dark, because a legacy text with no stored colour would
 * otherwise render white on white.
 *
 * background used to be compared against the literal "black"; now that it is
 * any hex colour, outlineColorFor(text.background) asks the same
 * light-or-dark question of every colour rather than just the original two.
 * Verified before relying on it: outlineColorFor("#FFFFFF") is "#111111" and
 * outlineColorFor("#111111") is "#FFFFFF", so a legacy tone still resolves the
 * way it always did.
 */
export function textColorOf(text: TextColorSource): string {
  const legacyDefault =
    text.style === "boxed" ? outlineColorFor(text.background) : "#FFFFFF";
  return normalizeHexColor(text.color, legacyDefault);
}

/** Splits a hex colour into channels, falling back to white (app.js:237-244). */
export function hexToRgb(hex: string | null | undefined): Rgb {
  const value = normalizeHexColor(hex, "#FFFFFF").slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/**
 * Reads back a CSS rgb() string, or any three numbers, as a hex colour
 * (app.js:246-253). Returns null when the input carries no three channels.
 */
export function rgbToHex(value: string | null | undefined): string | null {
  const channels = String(value ?? "").match(/-?\d+(?:\.\d+)?/g);
  if (!channels || channels.length !== 3) return null;
  const hex = channels
    .map((channel) =>
      Math.round(clamp(Number(channel), 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return normalizeHexColor(hex);
}

/** Renders a hex colour as the CSS rgb() string (app.js:255-258). */
export function formatRgb(hex: string | null | undefined): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

/** The outline that keeps a colour legible against itself (app.js:260-264). */
export function outlineColorFor(hex: string | null | undefined): string {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

/**
 * Flips a boxed text whose colour matches its own pill (app.js:266-270).
 * Returns the same layer when nothing needs changing, so a caller can compare
 * references to see whether it acted.
 *
 * Compares against text.background directly now that it is a hex colour,
 * rather than rebuilding it from the retired white/black enum. Falls back to
 * "#FFFFFF" when background is absent or empty, matching textColorOf's own
 * legacy default (the schema never produces either, but a hand-built fixture
 * that skips validation can). The match stays exact on purpose: a luminance
 * threshold would silently rewrite a colour the author picked on purpose,
 * which is why one was rejected here.
 */
export function ensureBoxedTextContrast<T extends TextColorSource>(text: T): T {
  if (text.style !== "boxed") return text;
  const backgroundColor = text.background || "#FFFFFF";
  if (textColorOf(text) !== backgroundColor) return text;
  return { ...text, color: outlineColorFor(backgroundColor) };
}
