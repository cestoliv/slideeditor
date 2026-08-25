import { DEFAULT_RATIO, type Ratio } from "../schema/document.js";

/** The slide canvas is authored at this width, and every layout coordinate is relative to it (app.js:1). */
export const DESIGN_WIDTH = 1080;

/** Every export renders at this width, whatever the ratio (app.js:2). */
export const OUTPUT_WIDTH = 1080;

/** Slide thumbnails render at this width (app.js:44). */
export const THUMBNAIL_WIDTH = 540;

export interface RatioPreset extends Ratio {
  label: string;
  note: string;
}

/** The offered ratios, in the order the picker shows them (app.js:4-10). */
export const RATIO_PRESETS: readonly RatioPreset[] = [
  { w: 9, h: 16, label: "9:16", note: "TikTok · Reels · Stories" },
  { w: 3, h: 4, label: "3:4", note: "Instagram tall portrait" },
  { w: 4, h: 5, label: "4:5", note: "Instagram portrait" },
  { w: 1, h: 1, label: "1:1", note: "Square" },
  { w: 1.91, h: 1, label: "1.91:1", note: "Instagram landscape" },
];

// Instagram accepts 3:4 through 1.91:1. TikTok's own 9:16 falls below that
// band, so custom values are allowed wider and only flagged, never blocked
// (app.js:11-16).
export const INSTAGRAM_MIN_RATIO = 3 / 4;
export const INSTAGRAM_MAX_RATIO = 1.91;
export const CUSTOM_RATIO_MIN = 0.4;
export const CUSTOM_RATIO_MAX = 2.5;

// A preset stores 1.91 rather than the exact 1.91:1 arithmetic, and a user can
// type 191:100, so ratios are compared with slack rather than for equality
// (app.js:466, app.js:477).
const RATIO_MATCH_TOLERANCE = 0.0005;

/**
 * Repairs a ratio that arrives from outside a parsed document (app.js:444-449).
 * The ratio menu builds one from two text inputs, and outputHeight divides by
 * ratio.w, so a zero or a stray letter has to be caught before it gets there.
 */
export function normalizeRatio(
  ratio: { w?: number; h?: number } | null | undefined,
): Ratio {
  const w = Number(ratio?.w);
  const h = Number(ratio?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ...DEFAULT_RATIO };
  }
  return { w, h };
}

/** The rendered height for a ratio, in output pixels (app.js:451-455). */
export function outputHeight(ratio: Ratio): number {
  // An even height keeps the export free of half-pixel rounding.
  return Math.max(2, Math.round((OUTPUT_WIDTH * ratio.h) / ratio.w / 2) * 2);
}

/**
 * Width over height of the rendered canvas (app.js:457-459). This is the
 * rounded output aspect, not `ratio.w / ratio.h`, so a layer measured against
 * it lands on the same pixels the export writes.
 */
export function outputAspect(ratio: Ratio): number {
  return OUTPUT_WIDTH / outputHeight(ratio);
}

/** The height of a slide thumbnail, in pixels (app.js:461-463). */
export function thumbnailHeight(ratio: Ratio): number {
  return Math.max(2, Math.round(THUMBNAIL_WIDTH / outputAspect(ratio) / 2) * 2);
}

function formatRatioPart(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** The preset name for a ratio, or the numbers themselves (app.js:465-471). */
export function ratioLabel(ratio: Ratio): string {
  const preset = RATIO_PRESETS.find(
    (item) => Math.abs(item.w / item.h - ratio.w / ratio.h) < RATIO_MATCH_TOLERANCE,
  );
  if (preset) return preset.label;
  return `${formatRatioPart(ratio.w)}:${formatRatioPart(ratio.h)}`;
}

/** True when Instagram accepts the ratio as it stands (app.js:476-479). */
export function isInstagramSafeRatio(ratio: Ratio): boolean {
  const value = ratio.w / ratio.h;
  return (
    value >= INSTAGRAM_MIN_RATIO - RATIO_MATCH_TOLERANCE &&
    value <= INSTAGRAM_MAX_RATIO + RATIO_MATCH_TOLERANCE
  );
}

/** True when a typed ratio sits inside the band the editor accepts (app.js:846-847). */
export function isRatioInCustomBand(ratio: Ratio): boolean {
  const value = ratio.w / ratio.h;
  return value >= CUSTOM_RATIO_MIN && value <= CUSTOM_RATIO_MAX;
}

/** True when two ratios describe the same canvas, 9:16 and 18:32 included. */
export function sameRatio(a: Ratio, b: Ratio): boolean {
  return Math.abs(a.w / a.h - b.w / b.h) < RATIO_MATCH_TOLERANCE;
}

/** The chrome the preview suggests for a ratio (app.js:481-484). */
export function suggestedChrome(ratio: Ratio): "tiktok" | "instagram-feed" {
  return ratio.w / ratio.h < 0.7 ? "tiktok" : "instagram-feed";
}
