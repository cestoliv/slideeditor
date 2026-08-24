import { clamp } from "@shared/geometry/index.js";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "@shared/text/index.js";

/*
 * The font size slider, ported from interpolateFontSizeControl,
 * fontSizeFromSliderPosition, sliderPositionFromFontSize and formatFontSize
 * (app.js:1902-1932).
 *
 * The slider does not carry the size directly. Sizes people actually pick sit
 * between 20 and 70, so a linear track would bunch every useful value into its
 * first third. The four stops below bend the track so that half of it covers
 * the bottom third of the range.
 */

/** app.js:42. The travel of the slider, in its own units. */
export const FONT_SIZE_SLIDER_MAX = 1000;

/** app.js:43. The slider moves in whole steps of this. */
export const FONT_SIZE_SLIDER_STEP = 10;

type Stop = { position: number; size: number };

/** app.js:47-52. */
const FONT_SIZE_SLIDER_STOPS: readonly Stop[] = [
  { position: 0, size: FONT_SIZE_MIN },
  { position: 220, size: 40 },
  { position: 780, size: 70 },
  { position: FONT_SIZE_SLIDER_MAX, size: FONT_SIZE_MAX },
];

const FIRST_STOP = FONT_SIZE_SLIDER_STOPS[0] as Stop;
const LAST_STOP = FONT_SIZE_SLIDER_STOPS[FONT_SIZE_SLIDER_STOPS.length - 1] as Stop;

/**
 * Walks the stops in either direction (app.js:1902-1917). `inputKey` names the
 * axis the value arrives on and `outputKey` the one it leaves on, so one
 * function serves both conversions and the two can never fall out of step.
 */
function interpolate(value: number, inputKey: keyof Stop, outputKey: keyof Stop): number {
  const bounded = clamp(
    Number.isFinite(value) ? value : FIRST_STOP[inputKey],
    FIRST_STOP[inputKey],
    LAST_STOP[inputKey],
  );
  const upperIndex = FONT_SIZE_SLIDER_STOPS.findIndex(
    (stop) => bounded <= stop[inputKey],
  );
  if (upperIndex <= 0) return FIRST_STOP[outputKey];
  const lower = FONT_SIZE_SLIDER_STOPS[upperIndex - 1] as Stop;
  const upper = FONT_SIZE_SLIDER_STOPS[upperIndex] as Stop;
  const progress = (bounded - lower[inputKey]) / (upper[inputKey] - lower[inputKey]);
  return lower[outputKey] + (upper[outputKey] - lower[outputKey]) * progress;
}

/** The size a slider position stands for, on the half pixel (app.js:1919-1921). */
export function fontSizeFromSliderPosition(position: number): number {
  return Math.round(interpolate(position, "position", "size") * 2) / 2;
}

/** Where a size sits on the slider, on the slider's own step (app.js:1923-1926). */
export function sliderPositionFromFontSize(size: number): number {
  const position = interpolate(size, "size", "position");
  return Math.round(position / FONT_SIZE_SLIDER_STEP) * FONT_SIZE_SLIDER_STEP;
}

/**
 * A typed size, bounded and rounded (app.js:2358-2360).
 *
 * An empty or unreadable box reads as the minimum rather than as zero, which is
 * what `Number(value) || FONT_SIZE_MIN` buys: a half-typed number never
 * collapses the text to nothing on the way through.
 */
export function clampFontSize(value: string | number): number {
  return (
    Math.round(clamp(Number(value) || FONT_SIZE_MIN, FONT_SIZE_MIN, FONT_SIZE_MAX) * 2) /
    2
  );
}

/** The size as it is shown, with a decimal only when there is one (app.js:1928-1931). */
export function formatFontSize(size: number | string): string {
  const value = clampFontSize(size);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
