// Every value here started out transcribed from server/compose.mjs:5-18. The
// geometry the golden fixture records depends on all of them, so a tweak to
// any one is a behaviour change, not a tidy-up. The one exception is the size
// ladder itself (server/compose.mjs:12-13): that shrink-to-fit behaviour was
// deliberately dropped, and TEXT_SMALLEST_SIZE went with it.

/** Side gutter, as a fraction of the slide width (server/compose.mjs:6). */
export const SIDE_MARGIN = 0.06;

/** The band a text spans between the two gutters (server/compose.mjs:7). */
export const CONTENT_WIDTH = 1 - SIDE_MARGIN * 2;

/** Clearance kept below the last text (server/compose.mjs:8). */
export const TEXT_BOTTOM_MARGIN = 0.08;

/** Preferred spacing between stacked texts (server/compose.mjs:9). */
export const TEXT_GAP = 0.022;

/** The spacing tried once the preferred one overflows (server/compose.mjs:10). */
export const TEXT_GAP_TIGHT = 0.01;

/**
 * The tallest a text block may be at TEXT_GAP before layoutTexts falls back
 * to TEXT_GAP_TIGHT instead (server/compose.mjs:11). Originally the point
 * past which the size ladder shrank the block to fit; the ladder is gone
 * (product decision, see this file's own header comment), so past this a
 * block only tries the tighter gap — nothing shrinks any more.
 */
export const TEXT_BLOCK_MAX = 0.46;

/**
 * The highest a text block may start when it fits within the frame between
 * this and TEXT_BOTTOM_MARGIN (server/compose.mjs:14). A block too tall for
 * that is centered on the whole frame instead (layoutTexts), so this is not
 * a hard floor: an unfittable block's top can sit above it.
 */
export const TEXT_TOP_LIMIT = 0.02;

/** Line height the wrap estimate assumes (server/compose.mjs:15). */
export const TEXT_LINE_HEIGHT = 1.12;

/** Clearance kept above the first asset row (server/compose.mjs:16). */
export const ASSET_TOP_MARGIN = 0.07;

/** Spacing between assets, both across a row and between rows (server/compose.mjs:17). */
export const ASSET_GAP = 0.03;

/** The most assets a single row holds (server/compose.mjs:18). */
export const ASSET_ROW_MAX = 3;
