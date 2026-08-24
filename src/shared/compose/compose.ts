import { DESIGN_WIDTH, outputHeight } from "../geometry/index.js";
import { DEFAULT_RATIO } from "../schema/index.js";
import type {
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
  TEXT_SIZE_FLOOR,
  TEXT_SIZES,
  TEXT_SMALLEST_SIZE,
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
  previous?: SlideDocument | null | undefined;
  newId?: (() => string) | undefined;
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
  previousSlide: Slide | null;
  ratioChanged: boolean;
  newId: () => string;
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
  previous = null,
  newId = defaultNewId,
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
        previousSlide: previousSlides[index] || null,
        ratioChanged: previous ? !sameRatio(previous.ratio, safeRatio) : false,
        newId,
      }),
    ),
  };
}

function composeSlide({
  composition,
  index,
  ratio,
  library,
  previousSlide,
  ratioChanged,
  newId,
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
  const laidOutTexts = layoutTexts(texts, height);
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
          id: newId(),
          text: placed.text,
          x: SIDE_MARGIN,
          y: placed.y,
          width: CONTENT_WIDTH,
          height: placed.height,
          size: placed.size,
          style: "plain" as const,
          color: "#FFFFFF",
          background: "white" as const,
          backgroundShape: "lines" as const,
          align: "center" as const,
          rotation: 0,
          z: z++,
        };
  });
  return slide;
}

/** Stacks texts in the lower third, shrinking the gap first and the size second. */
function layoutTexts(texts: string[], height: number): PlacedText[] {
  if (!texts.length) return [];
  for (const size of TEXT_SIZES) {
    for (const gap of [TEXT_GAP, TEXT_GAP_TIGHT]) {
      const boxes = texts.map((text) => ({
        text,
        size,
        height: textHeight(text, size, height),
      }));
      const total =
        boxes.reduce((sum, box) => sum + box.height, 0) + gap * (boxes.length - 1);
      if (total > TEXT_BLOCK_MAX) continue;
      let cursor = 1 - TEXT_BOTTOM_MARGIN - total;
      return boxes.map((box) => {
        const placed = { ...box, y: cursor };
        cursor += box.height + gap;
        return placed;
      });
    }
  }
  // Nothing fits even at the floor size. Scale the whole block down so it stays
  // on the canvas: an unreadable box beats one that runs off the slide.
  const floor = TEXT_SMALLEST_SIZE;
  const available = 1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT;
  const raw = texts.map((text) => ({ text, height: textHeight(text, floor, height) }));
  const gaps = TEXT_GAP_TIGHT * (raw.length - 1);
  const total = raw.reduce((sum, box) => sum + box.height, 0) + gaps;
  const scale =
    total > available ? Math.max(0.05, (available - gaps) / (total - gaps)) : 1;
  const boxes = raw.map((box) => ({
    text: box.text,
    size: Math.max(TEXT_SIZE_FLOOR, Math.round(floor * scale)),
    height: box.height * scale,
  }));
  let cursor = Math.max(
    TEXT_TOP_LIMIT,
    1 - TEXT_BOTTOM_MARGIN - (boxes.reduce((sum, box) => sum + box.height, 0) + gaps),
  );
  return boxes.map((box) => {
    const placed = { ...box, y: cursor };
    cursor += box.height + TEXT_GAP_TIGHT;
    return placed;
  });
}

/**
 * Estimates wrapped height without a font. The editor remeasures on render, so
 * this only has to be close enough to place the block sensibly.
 */
function textHeight(text: string, size: number, height: number): number {
  const charactersPerLine = Math.max(
    8,
    Math.floor((CONTENT_WIDTH * DESIGN_WIDTH) / (size * 0.5)),
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
  const areaBottom = Math.max(areaTop + 0.08, textBlockTop - 0.04);
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

export function validateComposition(slides: unknown): Composition[] {
  if (!Array.isArray(slides) || !slides.length) {
    throw new ComposeError("A slideshow needs at least one slide.");
  }
  // Array.isArray narrows unknown to any[], which this module bans, so the
  // checked value carries on under an explicit element type instead.
  const list: unknown[] = slides;
  if (list.length > 100)
    throw new ComposeError("A slideshow can hold at most 100 slides.");
  list.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") {
      throw new ComposeError(`Slide ${index + 1} is not an object.`);
    }
    if (!(slide as { background?: unknown }).background) {
      throw new ComposeError(`Slide ${index + 1} needs a background library item id.`);
    }
  });
  return list as Composition[];
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
  if (w / h < 0.4 || w / h > 2.5)
    throw new ComposeError("Keep the ratio between 0.4:1 and 2.5:1.");
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
