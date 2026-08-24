// Every value here is transcribed from server/compose.mjs:5-18. The geometry
// the golden fixture records depends on all of them, so a tweak to any one is
// a behaviour change, not a tidy-up.

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

/** The tallest the whole text block may grow before the size drops (server/compose.mjs:11). */
export const TEXT_BLOCK_MAX = 0.46;

// TEXT_SIZES.at(-1) is the size the overflow fallback scales from
// (server/compose.mjs:154). Naming it separately lets the fallback read it
// without an index the type checker has to treat as possibly out of range.
/** The smallest rung of the size ladder (server/compose.mjs:12). */
export const TEXT_SMALLEST_SIZE = 36;

/** The sizes tried in order, largest first (server/compose.mjs:12). */
export const TEXT_SIZES = [64, 56, 48, 42, TEXT_SMALLEST_SIZE];

/** No scaled size ever falls below this (server/compose.mjs:13). */
export const TEXT_SIZE_FLOOR = 20;

/** The highest a scaled text block may start (server/compose.mjs:14). */
export const TEXT_TOP_LIMIT = 0.02;

/** Line height the wrap estimate assumes (server/compose.mjs:15). */
export const TEXT_LINE_HEIGHT = 1.12;

/** Clearance kept above the first asset row (server/compose.mjs:16). */
export const ASSET_TOP_MARGIN = 0.07;

/** Spacing between assets, both across a row and between rows (server/compose.mjs:17). */
export const ASSET_GAP = 0.03;

/** The most assets a single row holds (server/compose.mjs:18). */
export const ASSET_ROW_MAX = 3;
