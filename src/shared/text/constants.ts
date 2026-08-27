// Every value here is a ratio of the font size, not a pixel count, so one set of
// constants drives both the on-screen stage and the 1080-pixel export.
// Ported verbatim from app.js:29-41.

/** Font weight for every rendered text line (app.js:30). */
export const TEXT_WEIGHT = 500;

/** Line advance for plain and outline text, as a multiple of the font size (app.js:31). */
export const TEXT_LINE_HEIGHT = 1.12;

/** Line advance for per-line boxed text (app.js:35). Equal to TEXT_LINE_HEIGHT today, but
 * the two are tuned independently, so they stay separate names. */
export const BOX_TEXT_LINE_HEIGHT = 1.12;

/** Pill height for per-line boxed text (app.js:36). Taller than the line advance, so
 * consecutive pills overlap and read as one shape. */
export const BOX_LINE_HEIGHT = 1.42;

/** Padding added to each side of a pill (app.js:37). */
export const BOX_HORIZONTAL_PADDING = 0.52;

/** Corner rounding on a pill's outer edges (app.js:38). */
export const BOX_CORNER_RADIUS = 0.27;

/** Rounding of the concave notch where two pills of different widths meet (app.js:39). */
export const BOX_JUNCTION_RADIUS = 0.18;

/** Outline stroke width for the outline text style (app.js:29). */
export const OUTLINE_RATIO = 0.17;

/** Smallest author-selectable font size, in design pixels (app.js:40). */
export const FONT_SIZE_MIN = 20;

/** Largest author-selectable font size, in design pixels (app.js:41). */
export const FONT_SIZE_MAX = 180;

/** Rounding of a full-box background, as a multiple of the font size (app.js:4465). */
export const BOX_FULL_CORNER_RADIUS = 0.18;

/** Inset of the text draw point from the box edge for left and right alignment
 * (app.js:4460). */
export const TEXT_HORIZONTAL_INSET = 0.16;

/** Total width the wrapper reserves for the text inset (app.js:2745, app.js:4454).
 * Both render paths already subtract this same amount before wrapping. */
export const TEXT_WRAP_INSET = 0.32;

/** Vertical slack subtracted from the box before counting how many lines fit
 * (app.js:4444). */
export const TEXT_VERTICAL_PADDING = 0.1;

/** The family a text layer uses when it names none of its own. */
export const DEFAULT_FONT_FAMILY = "TikTok Sans";

/**
 * Average glyph advance, as a fraction of font size — the compose engine's
 * line-wrap estimate (shared/compose/compose.ts's textHeight) has no font
 * file to measure against, so this stands in for one. The best guess
 * available for a family with no measured value of its own: this is what a
 * Google font falls back to today, since nothing in this codebase extracts
 * font metrics.
 *
 * This is the fallback only. The real per-family value — every family this
 * codebase has actually tuned, both bundled builtins included — lives in the
 * `font` table's own `advance` column (services/fonts.ts's
 * FontService.advanceRatioFor, seeded by BUILTIN_FONTS there), which is
 * shared code with no database to read: composeDocument takes an
 * `advanceRatioFor` a caller with a real catalogue can inject, and
 * `advanceRatioFor` below — this module's own, name-keyed version — is only
 * what a caller lacking one (or a test) gets instead.
 */
export const DEFAULT_ADVANCE_RATIO = 0.5;

/** advanceRatioFor's own fallback for a caller with no font catalogue to inject — see its doc comment above. */
export function advanceRatioFor(_family: string): number {
  return DEFAULT_ADVANCE_RATIO;
}

/** Fallback chain for the DOM and SVG paths, which name a family rather than measure one. */
export function fontStack(family: string): string {
  return `"${family}", sans-serif`;
}

/**
 * The canvas `font` shorthand for one font size and family, matching
 * app.js:2739 and app.js:4449.
 *
 * Measurement is injected, so this module cannot check what its callers bind.
 * A one-character difference between two callers' font strings rewraps every
 * line, and no test inside this module can see it, so both the measuring
 * canvas and the paint path must build this string from the same layer's
 * `fontFamily` and read it from here rather than writing their own.
 *
 * `weight` defaults to TEXT_WEIGHT, but a caller that knows a family's real
 * weight (src/web/app/fontFaces.ts weightFor) should pass it: a face
 * catalogued at a different weight than requested makes the browser
 * synthesise bold on some render paths and not others, which is exactly the
 * mismatch this shared string exists to prevent.
 */
export function textFontString(
  fontSize: number,
  family: string,
  weight: number = TEXT_WEIGHT,
): string {
  return `${weight} ${fontSize}px "${family}"`;
}
