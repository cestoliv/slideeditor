import {
  DESIGN_WIDTH,
  ensureBoxedTextContrast,
  outputHeight,
} from "../geometry/index.js";
import {
  DEFAULT_RATIO,
  RATIO_ASPECT_MAX,
  RATIO_ASPECT_MIN,
  styledTextSchema,
} from "../schema/index.js";
import { newTextLayer } from "../defaults/index.js";
import {
  BOX_TEXT_LINE_HEIGHT,
  TEXT_LINE_HEIGHT,
  TEXT_VERTICAL_PADDING,
  TEXT_WRAP_INSET,
  advanceRatioFor as defaultAdvanceRatioFor,
  wrapText,
} from "../text/index.js";
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
  ASSET_LEFT,
  ASSET_MAX_WIDTH,
  ASSET_ROW_MAX,
  ASSET_TEXT_GAP,
  ASSET_TOP,
  ASSET_TOP_MARGIN,
  SAFE_BOTTOM,
  SAFE_RIGHT,
  SAFE_TOP,
  SIDE_MARGIN,
  TEXT_BOTTOM_MARGIN,
  TEXT_CENTER_FIRST,
  TEXT_CENTER_LAST,
  TEXT_CENTER_MIDDLE,
  TEXT_GAP,
  TEXT_LEFT,
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

/**
 * The style an agent may set on one line of text. Position and box size stay
 * the server's to place, so nothing here moves a line.
 */
export type TextStyle = Partial<
  Pick<
    TextLayer,
    "size" | "style" | "color" | "background" | "weight" | "italic" | "align"
  >
>;

const TEXT_STYLE_KEYS = [
  "size",
  "style",
  "color",
  "background",
  "weight",
  "italic",
  "align",
] as const satisfies readonly (keyof TextStyle)[];

/** A line of text: a plain string takes the account's defaults. */
export type CompositionText = string | ({ text: string } & TextStyle);

/** The shorthand an agent speaks: a background id, asset ids, and texts. */
export interface Composition {
  name?: string;
  background: string;
  assets?: string[];
  texts?: CompositionText[];
}

interface StyledText {
  text: string;
  style: TextStyle;
}

export interface ComposeDocumentInput {
  ratio: Ratio | undefined;
  slides: Composition[];
  library: LibraryLookup;
  defaults: AccountDefaults;
  previous?: SlideDocument | null | undefined;
  newId?: (() => string) | undefined;
  /**
   * The per-family average glyph advance measureTexts estimates line-wrap
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

interface MeasuredText {
  text: string;
  style: TextStyle;
  size: number;
  height: number;
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
  slideCount: number;
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
        slideCount: slides.length,
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
  slideCount,
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
  const texts = normalizeList(composition.texts).map(toStyledText);
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
  const measured = measureTexts(texts, height, defaults, advanceRatioFor);
  const total =
    measured.reduce((sum, box) => sum + box.height, 0) +
    TEXT_GAP * Math.max(0, measured.length - 1);
  const fitsSafeZone = total <= SAFE_BOTTOM - SAFE_TOP;
  const fallbackTop = fallbackTextTop(total);
  // Assets go first and leave room for the whole text block below them, so
  // pushing the text under the lowest asset keeps it in the zone. The one
  // exception is a block that leaves assets less than layoutAssets' floor.
  const assetAreaBottom = !measured.length
    ? SAFE_BOTTOM
    : fitsSafeZone
      ? SAFE_BOTTOM - total - ASSET_TEXT_GAP
      : fallbackTop >= 0
        ? fallbackTop - 0.04
        : 1 - TEXT_BOTTOM_MARGIN;
  const laidOutAssets = layoutAssets(assets, height, assetAreaBottom);
  const lowestAsset = Math.max(
    -Infinity,
    ...laidOutAssets.map((asset) => asset.y + asset.height),
  );
  const textTop = fitsSafeZone
    ? Math.max(
        clamp(roleCenter(index, slideCount) - total / 2, SAFE_TOP, SAFE_BOTTOM - total),
        lowestAsset + ASSET_TEXT_GAP,
      )
    : fallbackTop;
  let cursor = textTop;
  const laidOutTexts = measured.map((box) => {
    const placed = { ...box, y: cursor };
    cursor += box.height + TEXT_GAP;
    return placed;
  });

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
    // A kept line has to wear the style asked for, or a restyle would be lost.
    const bucket = keptTexts.get(placed.text) || [];
    const index = bucket.findIndex((layer) => hasStyle(layer, placed.style));
    const reused = index === -1 ? undefined : bucket.splice(index, 1)[0];
    if (reused) return { ...reused, z: z++ };
    const layer: TextLayer = {
      ...newTextLayer(
        defaults,
        { x: textLeft(defaults.text.maxWidth), y: placed.y, z: z++ },
        newId,
      ),
      text: placed.text,
      height: placed.height,
    };
    // Only a styled line can land a box colour on its own text colour, so a
    // plain string keeps exactly the layer it always got.
    return Object.keys(placed.style).length
      ? ensureBoxedTextContrast({ ...layer, ...placed.style })
      : layer;
  });
  return slide;
}

/** Measures each text box at its own size and style, in canvas fractions. */
function measureTexts(
  texts: StyledText[],
  height: number,
  defaults: AccountDefaults,
  advanceRatioFor: (family: string) => number,
): MeasuredText[] {
  const advance = advanceRatioFor(defaults.text.fontFamily);
  return texts.map(({ text, style }) => {
    // Each line measures at its own size and style, because a hook set
    // larger than the rest wraps to more lines and needs a taller box.
    // Weight and italic do not change the estimate: the renderer's
    // computeTextLayout stays the source of truth for the real wrap.
    const size = style.size ?? defaults.text.size;
    // computeTextLayout picks the line advance off the same two fields, and
    // the two constants are tuned independently, so reading them here keeps
    // this estimate from drifting away from what the renderer lays out.
    const lineHeight =
      (style.style ?? defaults.text.style) === "boxed" &&
      defaults.text.backgroundShape !== "full"
        ? BOX_TEXT_LINE_HEIGHT
        : TEXT_LINE_HEIGHT;
    return {
      text,
      style,
      size,
      height: textHeight(text, size, height, advance, defaults.text.maxWidth, lineHeight),
    };
  });
}

/** Where a text block's centre goes: the hook sits high, the call to action low. */
function roleCenter(index: number, slideCount: number): number {
  if (index === 0) return TEXT_CENTER_FIRST;
  return index === slideCount - 1 ? TEXT_CENTER_LAST : TEXT_CENTER_MIDDLE;
}

/** Left edge of a text box: clear of the action buttons while it fits, centred otherwise. */
function textLeft(maxWidth: number): number {
  if (TEXT_LEFT + maxWidth <= SAFE_RIGHT) return TEXT_LEFT;
  return SIDE_MARGIN + maxWidth <= SAFE_RIGHT
    ? SAFE_RIGHT - maxWidth
    : (1 - maxWidth) / 2;
}

/**
 * Where a text block taller than the safe zone starts. Size is fixed at the
 * account's value, so a tall block cannot be shrunk to fit. Bottom-anchored
 * (the block's bottom edge at 1 - TEXT_BOTTOM_MARGIN) whenever flooring the
 * top at TEXT_TOP_LIMIT still leaves the block's bottom at or above y = 1,
 * that is whenever `total <= 1 - TEXT_TOP_LIMIT`. A block that cannot fit
 * even flush against the top is centred on the whole frame, overflowing top
 * and bottom equally: flooring it would run the whole excess off the bottom
 * edge, which on a 9:16 slide is where a platform's caption and action
 * chrome sit, and would clip a total just under 1 while headroom sits unused
 * above it.
 */
function fallbackTextTop(total: number): number {
  return total > 1 - TEXT_TOP_LIMIT
    ? (1 - total) / 2
    : Math.max(TEXT_TOP_LIMIT, 1 - TEXT_BOTTOM_MARGIN - total);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How tall one text box has to be, in canvas fractions, to show every line it
 * wraps to at the account's `maxWidth`. Nothing caps the result: a box grows
 * downwards for as long as the text needs, because the alternative is losing
 * the lines that do not fit.
 *
 * This wraps through the same wrapText computeTextLayout uses, and adds the
 * same TEXT_WRAP_INSET and TEXT_VERTICAL_PADDING, because the renderer clips
 * to `visibleLineCount` and drops whatever a shorter box cannot hold. The old
 * estimate here divided the character count by an average line length, which
 * ignored word boundaries and both insets, and so undercounted the lines of
 * most real captions: an 80-character caption wrapped to five lines, was
 * composed a three-line box, and lost its last two lines.
 *
 * Only measurement is still an estimate: `advance` is the family's average
 * glyph width as a fraction of size (advanceRatioFor), standing in for the
 * real face this module has no way to read.
 */
function textHeight(
  text: string,
  size: number,
  height: number,
  advance: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const measure = (line: string) => line.length * size * advance;
  const wrapWidth = Math.max(1, maxWidth * DESIGN_WIDTH - size * TEXT_WRAP_INSET);
  const lines = wrapText(text, wrapWidth, measure);
  const content = lines.length * size * lineHeight + size * TEXT_VERTICAL_PADDING * 2;
  return content / height;
}

/**
 * Places assets above `areaBottom`. A lone asset sits top left, at most
 * ASSET_MAX_WIDTH wide. Several share rows of at most three, centred in the
 * band left of SAFE_RIGHT.
 */
function layoutAssets(
  assets: LibraryItem[],
  height: number,
  areaBottom: number,
): PlacedAsset[] {
  if (!assets.length) return [];
  const areaTop = ASSET_TOP_MARGIN;
  // A tall text block leaves almost no room above it. The floor keeps every
  // asset visible, even if the text below it then leaves the safe zone or,
  // for a block taller than the zone, overlaps it.
  const bottom = Math.max(areaTop + 0.08, areaBottom);
  const aspectOf = (item: LibraryItem) => (item.height || 1) / (item.width || 1);

  const [lone] = assets;
  if (lone && assets.length === 1) {
    const aspect = aspectOf(lone);
    let width = ASSET_MAX_WIDTH;
    let boxHeight = (width * DESIGN_WIDTH * aspect) / height;
    if (ASSET_TOP + boxHeight > bottom) {
      boxHeight = bottom - ASSET_TOP;
      width = (boxHeight * height) / (DESIGN_WIDTH * aspect);
    }
    return [{ item: lone, x: ASSET_LEFT, y: ASSET_TOP, width, height: boxHeight }];
  }

  const areaHeight = bottom - areaTop;
  const rows = chunk(assets, ASSET_ROW_MAX);
  const rowHeight = (areaHeight - ASSET_GAP * (rows.length - 1)) / rows.length;
  const placed: PlacedAsset[] = [];
  // Every row uses the same column count, so a partial last row keeps the same
  // item size and simply sits centered instead of stretching.
  const columns = Math.min(assets.length, ASSET_ROW_MAX);
  const bandWidth = SAFE_RIGHT - SIDE_MARGIN;
  const slotWidth = (bandWidth - ASSET_GAP * (columns - 1)) / columns;

  rows.forEach((row, rowIndex) => {
    const sized = row.map((item) => {
      const aspect = aspectOf(item);
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
    let cursor = SIDE_MARGIN + (bandWidth - rowWidth) / 2;
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

function toStyledText(value: CompositionText): StyledText {
  if (typeof value !== "object") return { text: String(value), style: {} };
  // The raw HTTP route hands its body over unparsed, so this is where a bad
  // size or colour is refused. The schema strips every other key, so nothing
  // can set geometry through here.
  const parsed = styledTextSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ComposeError(
      `Text line ${JSON.stringify(value)} is invalid at ${issue?.path.join(".") || "text"}: ${issue?.message ?? "bad value"}`,
    );
  }
  // Zod leaves an absent key absent, so no field holds `undefined` here.
  const { text, ...style } = parsed.data;
  return { text, style: style as TextStyle };
}

/**
 * Whether a layer already wears the style asked for. An omitted field matches
 * anything, so a plain string sent back never wipes a line's style. The
 * request goes through the same contrast flip composeSlide applies, or a boxed
 * line asked for in its own box colour would never match and lose its
 * geometry on every update.
 */
function hasStyle(layer: TextLayer, style: TextStyle): boolean {
  const wanted = ensureBoxedTextContrast({ ...layer, ...style });
  return TEXT_STYLE_KEYS.every(
    (key) => style[key] === undefined || wanted[key] === layer[key],
  );
}

function sameComposition(
  slide: Slide,
  backgroundId: string,
  assetIds: string[],
  texts: StyledText[],
): boolean {
  if (slide.backgroundItemId !== backgroundId) return false;
  const currentAssets = (slide.overlays || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((overlay) => overlay.itemId);
  const currentTexts = (slide.texts || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0));
  return (
    sameList(currentAssets, assetIds) &&
    currentTexts.length === texts.length &&
    currentTexts.every(
      (layer, index) =>
        layer.text === texts[index]?.text && hasStyle(layer, texts[index].style),
    )
  );
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

function normalizeList<T>(value: T[] | T | null | undefined): T[] {
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
