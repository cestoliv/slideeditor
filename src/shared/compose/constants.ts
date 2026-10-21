// Every value here started out transcribed from server/compose.mjs:5-18. The
// geometry the golden fixture records depends on all of them, so a tweak to
// any one is a behaviour change, not a tidy-up. The one exception is the size
// ladder itself (server/compose.mjs:12-13): that shrink-to-fit behaviour was
// deliberately dropped, and TEXT_SMALLEST_SIZE went with it.

/** Side gutter, as a fraction of the slide width (server/compose.mjs:6). */
export const SIDE_MARGIN = 0.06;

/** Clearance kept below the last text (server/compose.mjs:8). */
export const TEXT_BOTTOM_MARGIN = 0.08;

/**
 * Spacing between stacked texts. Zero, because on published slideshows the
 * pills touch and read as one block (median gap −0.017).
 */
export const TEXT_GAP = 0;

/**
 * The highest a text block may start when it fits within the frame between
 * this and TEXT_BOTTOM_MARGIN (server/compose.mjs:14). A block too tall for
 * that is centered on the whole frame instead (fallbackTextTop in compose.ts), so this is not
 * a hard floor: an unfittable block's top can sit above it.
 */
export const TEXT_TOP_LIMIT = 0.02;

/** Clearance kept above the first asset row (server/compose.mjs:16). */
export const ASSET_TOP_MARGIN = 0.07;

// The safe zone and the placement targets below are measured on the 929
// slides published by hand before 2026-10-20, where nearly every text and
// asset was moved off the old defaults. TikTok draws its tabs above
// SAFE_TOP, its caption below SAFE_BOTTOM and its action buttons right of
// SAFE_RIGHT.

/** Top edge of the safe zone, as a fraction of the slide height. */
export const SAFE_TOP = 0.07;

/** Bottom edge of the safe zone, as a fraction of the slide height. */
export const SAFE_BOTTOM = 0.8;

/** Right edge of the safe zone, as a fraction of the slide width. */
export const SAFE_RIGHT = 0.76;

/** Left edge of a composed text. */
export const TEXT_LEFT = 0.1;

/** Vertical centre of the first slide's text block, the hook. */
export const TEXT_CENTER_FIRST = 0.36;

/** Vertical centre of a middle slide's text block. */
export const TEXT_CENTER_MIDDLE = 0.47;

/** Vertical centre of the last slide's text block, the call to action. */
export const TEXT_CENTER_LAST = 0.55;

/** Left edge of a lone asset. */
export const ASSET_LEFT = 0.14;

/** Top edge of a lone asset. */
export const ASSET_TOP = 0.1;

/** The widest a lone asset may be. */
export const ASSET_MAX_WIDTH = 0.4;

/** Clearance kept between the lowest asset and the text block below it. */
export const ASSET_TEXT_GAP = 0.02;

/** Spacing between assets, both across a row and between rows (server/compose.mjs:17). */
export const ASSET_GAP = 0.03;

/** The most assets a single row holds (server/compose.mjs:18). */
export const ASSET_ROW_MAX = 3;

/** Asset width for each `assetSize` an agent may pick, as a fraction of the slide width. */
export const ASSET_SIZE_WIDTHS = { small: 0.25, medium: 0.4, large: 0.6 } as const;
