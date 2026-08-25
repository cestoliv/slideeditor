/** Ports clamp (app.js:4124-4126), which every formula in this module leans on. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
