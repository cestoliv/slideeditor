import { suggestedChrome as suggestedPlatformChrome } from "@shared/geometry/index.js";
import type { Ratio } from "@shared/schema/index.js";

/*
 * The platform mock-ups the stage can wear, ported from PREVIEW_CHROMES
 * (app.js:22-26) and suggestedChrome (app.js:481-484).
 */

export type ChromeId = "none" | "tiktok" | "instagram-feed" | "instagram-story";

export type ChromeChoice = { id: Exclude<ChromeId, "none">; label: string };

/** app.js:22-26, in the order the menu lists them. */
export const PREVIEW_CHROMES: readonly ChromeChoice[] = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram-feed", label: "Instagram feed" },
  { id: "instagram-story", label: "Instagram Stories" },
];

/**
 * The chrome a ratio suggests (app.js:481-484). Task 4 owns the arithmetic,
 * because ratio comparison lives with the rest of it; this widens the answer to
 * ChromeId so a caller can hold one type for the menu and the overlay alike.
 */
export function suggestedChrome(ratio: Ratio): ChromeId {
  return suggestedPlatformChrome(ratio);
}
