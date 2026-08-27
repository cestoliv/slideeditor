import { DESIGN_WIDTH, outputHeight } from "../geometry/index.js";
import { DEFAULT_RATIO, RATIO_ASPECT_MAX, RATIO_ASPECT_MIN } from "../schema/index.js";
import { newTextLayer } from "../defaults/index.js";
import { advanceRatioFor as defaultAdvanceRatioFor } from "../text/index.js";
import type {
  AccountDefaults,
  LibraryItem,
  LibraryKind,
  Overlay,
  Ratio,
  Slide,
  SlideDocument,
  TextLayer,
} from "../schema/index.js";
import {
  ASSET_GAP,
  ASSET_ROW_MAX,
  ASSET_TOP_MARGIN,
  CONTENT_WIDTH,
  SIDE_MARGIN,
  TEXT_BLOCK_MAX,
  TEXT_BOTTOM_MARGIN,
  TEXT_GAP,
  TEXT_GAP_TIGHT,
  TEXT_LINE_HEIGHT,
  TEXT_TOP_LIMIT,
} from "./constants.js";

/**
 * Stands in for HttpError(400, …) (server/compose.mjs:2). The current server
 * answers a bad composition with a 400, and that status is part of the API
 * contract, so the error carries no status of its own and Task 8's handler
 * maps this class to 400.
 */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The slice of the library service compose needs (server/library.mjs:99-106). */
export interface LibraryLookup {
  require(id: string, kind?: LibraryKind): LibraryItem;
}

/** The shorthand an agent speaks: a background id, asset ids, and strings. */
export interface Composition {
  name?: string;
  background: string;
  assets?: string[];
  texts?: string[];
}

export interface ComposeDocumentInput {
  ratio: Ratio | undefined;
  slides: Composition[];
  library: LibraryLookup;
  defaults: AccountDefaults;
  previous?: SlideDocument | null | undefined;
  newId?: (() => string) | undefined;
  /**
   * The per-family average glyph advance layoutTexts estimates line-wrap
   * height from — this module has no font file to measure against, and
   * (being shared code) no database to read a measured one from either. A
   * caller with a font catalogue to consult (server/services/fonts.ts's
   * FontService.advanceRatioFor) passes it here; omitting it falls back to
   * the same shared, name-keyed constant this always used, which is what
   * every existing test (and any caller that predates this field) still
   * gets.
   */
  advanceRatioFor?: ((family: string) => number) | undefined;
}

/** A project row joined to its document, the shape toComposition reduces. */
export type CompositionSource = SlideDocument & {
  id: string;
  name: string;
  version: number;
};

export interface CompositionSlide {
  name: string;
  background: string | null;
  assets: string[];
  texts: string[];
}

export interface CompositionProject {
  id: string;
  name: string;
  version: number;
  ratio: Ratio;
  slides: CompositionSlide[];
}

interface PlacedText {
  text: string;
  size: number;
  height: number;
  y: number;
}

interface PlacedAsset {
  item: LibraryItem;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ComposeSlideInput {
  composition: Composition;
  index: number;
  ratio: Ratio;
  library: LibraryLookup;
  defaults: AccountDefaults;
  previousSlide: Slide | null;
  ratioChanged: boolean;
  newId: () => string;
  advanceRatioFor: (family: string) => number;
}

// Injected everywhere below so tests get deterministic ids, and so this module
// stays free of node:crypto. globalThis.crypto exists in Node 22 and in the
// browser alike.
function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Turns a composition (a background, asset ids and strings) into a full slide
 * document. Deterministic: the same input always yields the same geometry,
 * apart from generated ids.
 */
export function composeDocument({
  ratio,
  slides,
  library,
  defaults,
  previous = null,
  newId = defaultNewId,
  advanceRatioFor = defaultAdvanceRatioFor,
}: ComposeDocumentInput): SlideDocument {
  const safeRatio = normalizeRatio(ratio);
  const previousSlides = previous?.slides || [];
  return {
    ratio: safeRatio,
    slides: slides.map((composition, index) =>
      composeSlide({
        composition,
        index,
        ratio: safeRatio,
        library,
        defaults,
        previousSlide: previousSlides[index] || null,
        ratioChanged: previous ? !sameRatio(previous.ratio, safeRatio) : false,
        newId,
        advanceRatioFor,
      }),
    ),
  };
}

function composeSlide({
  composition,
  index,
  ratio,
  library,
  defaults,
  previousSlide,
  ratioChanged,
  newId,
  advanceRatioFor,
}: ComposeSlideInput): Slide {
  const background = library.require(composition.background, "background");
  const assetIds = normalizeList(composition.assets);
  const texts = normalizeList(composition.texts).map((value) => String(value));
  const assets = assetIds.map((id) => library.require(id, "asset"));

  // An unchanged composition keeps the slide exactly as the user left it.
  if (
    previousSlide &&
    !ratioChanged &&
    sameComposition(previousSlide, background.id, assetIds, texts)
  ) {
    return previousSlide;
  }

  const height = outputHeight(ratio);
  const laidOutTexts = layoutTexts(texts, height, defaults, advanceRatioFor);
  const textBlockTop = laidOutTexts.length
    ? Math.min(...laidOutTexts.map((text) => text.y))
    : 1;
  const laidOutAssets = layoutAssets(assets, height, textBlockTop);

  const slide: Slide = {
    id: previousSlide?.id || newId(),
    name: composition.name
      ? String(composition.name).slice(0, 120)
      : `Slide ${index + 1}`,
    backgroundItemId: background.id,
    width: background.width,
    height: background.height,
    imageScale: previousSlide?.imageScale ?? 1,
    imageX: previousSlide?.imageX ?? 0,
    imageY: previousSlide?.imageY ?? 0,
    overlays: [],
    texts: [],
  };

  // Geometry the user adjusted by hand survives wherever the same asset or the
  // same string is still on the slide.
  const keptOverlays = new Map<string, Overlay[]>();
  for (const overlay of previousSlide?.overlays || []) {
    if (ratioChanged) break;
    const bucket = keptOverlays.get(overlay.itemId) || [];
    bucket.push(overlay);
    keptOverlays.set(overlay.itemId, bucket);
  }
  const keptTexts = new Map<string, TextLayer[]>();
  for (const text of previousSlide?.texts || []) {
    if (ratioChanged) break;
    const bucket = keptTexts.get(text.text) || [];
    bucket.push(text);
    keptTexts.set(text.text, bucket);
  }

  let z = 1;
  slide.overlays = laidOutAssets.map((placed) => {
    const reused = keptOverlays.get(placed.item.id)?.shift();
    return reused
      ? { ...reused, z: z++ }
      : {
          id: newId(),
          itemId: placed.item.id,
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          rotation: 0,
          cropX: 0,
          cropY: 0,
          cropW: 1,
          cropH: 1,
          z: z++,
        };
  });
  slide.texts = laidOutTexts.map((placed) => {
    const reused = keptTexts.get(placed.text)?.shift();
    return reused
      ? { ...reused, z: z++ }
      : {
          ...newTextLayer(defaults, { x: SIDE_MARGIN, y: placed.y, z: z++ }, newId),
          text: placed.text,
          width: CONTENT_WIDTH,
          height: placed.height,
        };
  });
  return slide;
}

/** Stacks texts in the lower third at the account's text size, shrinking the gap if needed. */
function layoutTexts(
  texts: string[],
  height: number,
  defaults: AccountDefaults,
  advanceRatioFor: (family: string) => number,
): PlacedText[] {
  if (!texts.length) return [];
  const size = defaults.text.size;
  const advance = advanceRatioFor(defaults.text.fontFamily);
  const boxesAt = (gap: number) => {
    const boxes = texts.map((text) => ({
      text,
      size,
      height: textHeight(text, size, height, advance),
    }));
    const total =
      boxes.reduce((sum, box) => sum + box.height, 0) + gap * (boxes.length - 1);
    return { boxes, total };
  };
  const preferred = boxesAt(TEXT_GAP);
  // The tight gap is used whenever the preferred one overflows, whether or not
  // the tight gap itself fits: there is no smaller size to fall back to any
  // more, so a block that cannot fit either gap is placed anyway and allowed
  // to run off both edges of the slide equally (see the centering below).
  const { boxes, total, gap } =
    preferred.total <= TEXT_BLOCK_MAX
      ? { ...preferred, gap: TEXT_GAP }
      : { ...boxesAt(TEXT_GAP_TIGHT), gap: TEXT_GAP_TIGHT };
  // Size is fixed at the account's value now that the ladder is gone, so a
  // tall block cannot be shrunk to fit. Bottom-anchored (cursor keeps the
  // block's bottom edge at 1 - TEXT_BOTTOM_MARGIN) whenever flooring the top
  // at TEXT_TOP_LIMIT still leaves the block's bottom at or above y = 1 —
  // that is, whenever `total <= 1 - TEXT_TOP_LIMIT`. Centering on the whole
  // frame, overflowing top and bottom equally, is reserved for a block that
  // cannot fit even flush against the top (total > 1 - TEXT_TOP_LIMIT): only
  // then does spreading the overflow evenly beat flooring it at
  // TEXT_TOP_LIMIT and running the excess off the bottom edge, which on a
  // 9:16 slide is where a platform's caption and action chrome sit.
  //
  // The boundary used to be `total > 1`, which let a block just under that —
  // needing the top floored by less than TEXT_TOP_LIMIT of clearance — get
  // bottom-anchored anyway. Flooring then clamps the top at TEXT_TOP_LIMIT
  // rather than letting it go negative, so the *bottom* absorbs whatever
  // clearance the floor couldn't: a total of 0.984 (with TEXT_TOP_LIMIT at
  // 0.02) needs the top pushed up to -0.004 to sit flush against the bottom
  // margin, gets floored at 0.02 instead, and ends up with its bottom at
  // 1.004 — clipped off the slide, with 0.02 of headroom sitting unused
  // above it. Comparing against `1 - TEXT_TOP_LIMIT` instead catches every
  // total that flooring cannot place without clipping and routes it to
  // centering, which spends that same headroom evenly on both edges instead.
  let cursor =
    total > 1 - TEXT_TOP_LIMIT
      ? (1 - total) / 2
      : Math.max(TEXT_TOP_LIMIT, 1 - TEXT_BOTTOM_MARGIN - total);
  return boxes.map((box) => {
    const placed = { ...box, y: cursor };
    cursor += box.height + gap;
    return placed;
  });
}

/**
 * Estimates wrapped height without a font. The editor remeasures on render, so
 * this only has to be close enough to place the block sensibly. `advance` is
 * the family's average glyph width as a fraction of size (advanceRatioFor):
 * fontFamily is now per-account, and a fixed 0.5 tuned for TikTok Sans
 * undercounts lines for a wider face like Space Mono.
 */
function textHeight(text: string, size: number, height: number, advance: number): number {
  const charactersPerLine = Math.max(
    8,
    Math.floor((CONTENT_WIDTH * DESIGN_WIDTH) / (size * advance)),
  );
  const lines = Math.max(1, Math.ceil(text.length / charactersPerLine));
  return (lines * size * TEXT_LINE_HEIGHT) / height;
}

/** Spreads assets above the text block, at most three to a row, never overlapping it. */
function layoutAssets(
  assets: LibraryItem[],
  height: number,
  textBlockTop: number,
): PlacedAsset[] {
  if (!assets.length) return [];
  const areaTop = ASSET_TOP_MARGIN;
  // A block that overflows the top of the frame (textBlockTop < 0, possible
  // now that a fixed size can no longer shrink to fit — layoutTexts) leaves
  // no real boundary inside the frame to lay out against: text and assets
  // are already going to overlap somewhere no matter what this picks. Rather
  // than feed that off-canvas number into the same arithmetic and let the
  // 0.08 floor below eat it, this falls back to the frame's own bottom
  // margin — the area assets would get if there were no text at all — so an
  // account's overflowing caption can no longer collapse every asset on the
  // slide to a sliver as a side effect nobody chose.
  const areaBottom =
    textBlockTop >= 0
      ? Math.max(areaTop + 0.08, textBlockTop - 0.04)
      : 1 - TEXT_BOTTOM_MARGIN;
  const areaHeight = areaBottom - areaTop;
  const rows = chunk(assets, ASSET_ROW_MAX);
  const rowHeight = (areaHeight - ASSET_GAP * (rows.length - 1)) / rows.length;
  const placed: PlacedAsset[] = [];
  // Every row uses the same column count, so a partial last row keeps the same
  // item size and simply sits centered instead of stretching.
  const columns = Math.min(assets.length, ASSET_ROW_MAX);
  const slotWidth = (CONTENT_WIDTH - ASSET_GAP * (columns - 1)) / columns;

  rows.forEach((row, rowIndex) => {
    const sized = row.map((item) => {
      const aspect = (item.height || 1) / (item.width || 1);
      let width = slotWidth;
      let boxHeight = (width * DESIGN_WIDTH * aspect) / height;
      if (boxHeight > rowHeight) {
        boxHeight = rowHeight;
        width = (boxHeight * height) / (DESIGN_WIDTH * aspect);
      }
      return { item, width, height: boxHeight };
    });
    const rowWidth =
      sized.reduce((sum, box) => sum + box.width, 0) + ASSET_GAP * (row.length - 1);
    const tallest = Math.max(...sized.map((box) => box.height));
    const rowTop = areaTop + rowIndex * (rowHeight + ASSET_GAP);
    let cursor = (1 - rowWidth) / 2;
    for (const box of sized) {
      placed.push({
        item: box.item,
        x: cursor,
        y: rowTop + (tallest - box.height) / 2,
        width: box.width,
        height: box.height,
      });
      cursor += box.width + ASSET_GAP;
    }
  });
  return placed;
}

/** Reduces a full document back to the composition shorthand the agent speaks. */
export function toComposition(project: CompositionSource): CompositionProject {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    ratio: project.ratio,
    slides: (project.slides || []).map((slide) => ({
      name: slide.name,
      background: slide.backgroundItemId || null,
      assets: (slide.overlays || [])
        .slice()
        .sort((a, b) => (a.z || 0) - (b.z || 0))
        .map((overlay) => overlay.itemId),
      texts: (slide.texts || [])
        .slice()
        .sort((a, b) => (a.z || 0) - (b.z || 0))
        .map((text) => text.text),
    })),
  };
}

/** An item looked up for account-scope checking; `name` makes the rejection
 * actionable when the caller's lookup provides one. */
interface ScopedItem {
  accountId: string;
  name?: string;
}

export interface AccountScopeContext {
  accountId: string;
  lookupItem: (id: string) => ScopedItem | null;
}

/**
 * The one cross-account rule, shared by every write path that can plant a
 * foreign library item into a slideshow: validateComposition (the agent's
 * Composition shorthand) and validateDocumentAccountScope (the raw document
 * ProjectService stores). This is the error a user actually hits on a
 * slideshow they cannot otherwise fix, so it names the slide and, when the
 * lookup can supply one, the item's name — not just an internal id.
 */
function assertOwnedByAccount(
  id: string,
  context: AccountScopeContext,
  describeSlide: () => string,
): void {
  const item = context.lookupItem(id);
  if (item && item.accountId !== context.accountId) {
    const label = item.name ? `"${item.name}" (${id})` : `library item ${id}`;
    throw new ComposeError(
      `${describeSlide()} references ${label} from a different account.`,
    );
  }
}

export function validateComposition(
  compositions: Composition[],
  context: AccountScopeContext,
): void {
  if (!Array.isArray(compositions) || !compositions.length) {
    throw new ComposeError("A slideshow needs at least one slide.");
  }
  // Array.isArray narrows unknown to any[], which this module bans, so the
  // checked value carries on under an explicit element type instead.
  const list: unknown[] = compositions;
  if (list.length > 100)
    throw new ComposeError("A slideshow can hold at most 100 slides.");
  list.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") {
      throw new ComposeError(`Slide ${index + 1} is not an object.`);
    }
    const composition = slide as Composition;
    if (!composition.background) {
      throw new ComposeError(`Slide ${index + 1} needs a background library item id.`);
    }
    const describeSlide = (): string =>
      `Slide ${index + 1}${composition.name ? ` ("${composition.name}")` : ""}`;
    const ids = [composition.background, ...(composition.assets ?? [])].filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    for (const id of ids) {
      assertOwnedByAccount(id, context, describeSlide);
    }
  });
}

/**
 * Same cross-account rule as validateComposition, over the raw document shape
 * ProjectService stores (a StoredDocument's `slides`, still `unknown[]` at
 * this point) instead of the agent's Composition shorthand. Extracts item ids
 * the same way ProjectService.reindex() does: a slide's backgroundItemId plus
 * each of its overlays' itemId. `/api/projects` accepts a raw document, so
 * this is what runs on that write path.
 */
export function validateDocumentAccountScope(
  slides: unknown[],
  context: AccountScopeContext,
): void {
  slides.forEach((entry, index) => {
    const slide = asRecord(entry);
    if (!slide) return;
    const slideName = typeof slide["name"] === "string" ? slide["name"] : undefined;
    const describeSlide = (): string =>
      `Slide ${index + 1}${slideName ? ` ("${slideName}")` : ""}`;
    const backgroundId = slide["backgroundItemId"];
    if (typeof backgroundId === "string" && backgroundId) {
      assertOwnedByAccount(backgroundId, context, describeSlide);
    }
    const overlays = slide["overlays"];
    if (!Array.isArray(overlays)) return;
    for (const candidate of overlays) {
      const overlay = asRecord(candidate);
      const itemId = overlay?.["itemId"];
      if (typeof itemId === "string" && itemId) {
        assertOwnedByAccount(itemId, context, describeSlide);
      }
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameComposition(
  slide: Slide,
  backgroundId: string,
  assetIds: string[],
  texts: string[],
): boolean {
  if (slide.backgroundItemId !== backgroundId) return false;
  const currentAssets = (slide.overlays || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((overlay) => overlay.itemId);
  const currentTexts = (slide.texts || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((text) => text.text);
  return sameList(currentAssets, assetIds) && sameList(currentTexts, texts);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRatio(a: Ratio, b: Ratio): boolean {
  return Boolean(a) && Math.abs(a.w / a.h - b.w / b.h) < 0.0005;
}

function normalizeRatio(ratio: Ratio | undefined): Ratio {
  const w = Number(ratio?.w);
  const h = Number(ratio?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return { ...DEFAULT_RATIO };
  if (w / h < RATIO_ASPECT_MIN || w / h > RATIO_ASPECT_MAX)
    throw new ComposeError(
      `Keep the ratio between ${String(RATIO_ASPECT_MIN)}:1 and ${String(RATIO_ASPECT_MAX)}:1.`,
    );
  return { w, h };
}

function normalizeList(value: string[] | string | null | undefined): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (entry) => entry != null && entry !== "",
  );
}

function chunk<T>(list: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < list.length; index += size)
    rows.push(list.slice(index, index + size));
  return rows;
}
