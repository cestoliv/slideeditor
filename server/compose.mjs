import { randomUUID } from "node:crypto";
import { HttpError } from "./library.mjs";
import { DEFAULT_RATIO } from "./projects.mjs";

const DESIGN_WIDTH = 1080;
const SIDE_MARGIN = 0.06;
const CONTENT_WIDTH = 1 - SIDE_MARGIN * 2;
const TEXT_BOTTOM_MARGIN = 0.08;
const TEXT_GAP = 0.022;
const TEXT_GAP_TIGHT = 0.01;
const TEXT_BLOCK_MAX = 0.46;
const TEXT_SIZES = [64, 56, 48, 42, 36];
const TEXT_SIZE_FLOOR = 20;
const TEXT_TOP_LIMIT = 0.02;
const TEXT_LINE_HEIGHT = 1.12;
const ASSET_TOP_MARGIN = 0.07;
const ASSET_GAP = 0.03;
const ASSET_ROW_MAX = 3;

export function outputHeight(ratio) {
  return Math.max(2, Math.round((DESIGN_WIDTH * ratio.h) / ratio.w / 2) * 2);
}

/**
 * Turns a composition (a background, asset ids and strings) into a full slide
 * document. Deterministic: the same input always yields the same geometry,
 * apart from generated ids.
 */
export function composeDocument({ ratio, slides, library, previous = null }) {
  const safeRatio = normalizeRatio(ratio);
  const previousSlides = previous?.slides || [];
  return {
    ratio: safeRatio,
    slides: slides.map((composition, index) => composeSlide({
      composition,
      index,
      ratio: safeRatio,
      library,
      previousSlide: previousSlides[index] || null,
      ratioChanged: previous ? !sameRatio(previous.ratio, safeRatio) : false,
    })),
  };
}

function composeSlide({ composition, index, ratio, library, previousSlide, ratioChanged }) {
  const background = library.require(composition.background, "background");
  const assetIds = normalizeList(composition.assets);
  const texts = normalizeList(composition.texts).map((value) => String(value));
  const assets = assetIds.map((id) => library.require(id, "asset"));

  // An unchanged composition keeps the slide exactly as the user left it.
  if (previousSlide && !ratioChanged && sameComposition(previousSlide, background.id, assetIds, texts)) {
    return previousSlide;
  }

  const height = outputHeight(ratio);
  const laidOutTexts = layoutTexts(texts, height);
  const textBlockTop = laidOutTexts.length ? Math.min(...laidOutTexts.map((text) => text.y)) : 1;
  const laidOutAssets = layoutAssets(assets, height, textBlockTop);

  const slide = {
    id: previousSlide?.id || randomUUID(),
    name: composition.name ? String(composition.name).slice(0, 120) : `Slide ${index + 1}`,
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
  const keptOverlays = new Map();
  for (const overlay of previousSlide?.overlays || []) {
    if (ratioChanged) break;
    const bucket = keptOverlays.get(overlay.itemId) || [];
    bucket.push(overlay);
    keptOverlays.set(overlay.itemId, bucket);
  }
  const keptTexts = new Map();
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
          id: randomUUID(),
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
          id: randomUUID(),
          text: placed.text,
          x: SIDE_MARGIN,
          y: placed.y,
          width: CONTENT_WIDTH,
          height: placed.height,
          size: placed.size,
          style: "plain",
          outlineWidth: 12,
          color: "#FFFFFF",
          background: "white",
          backgroundShape: "lines",
          align: "center",
          rotation: 0,
          z: z++,
        };
  });
  return slide;
}

/** Stacks texts in the lower third, shrinking the gap first and the size second. */
function layoutTexts(texts, height) {
  if (!texts.length) return [];
  for (const size of TEXT_SIZES) {
    for (const gap of [TEXT_GAP, TEXT_GAP_TIGHT]) {
      const boxes = texts.map((text) => ({ text, size, height: textHeight(text, size, height) }));
      const total = boxes.reduce((sum, box) => sum + box.height, 0) + gap * (boxes.length - 1);
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
  const floor = TEXT_SIZES.at(-1);
  const available = 1 - TEXT_BOTTOM_MARGIN - TEXT_TOP_LIMIT;
  const raw = texts.map((text) => ({ text, height: textHeight(text, floor, height) }));
  const gaps = TEXT_GAP_TIGHT * (raw.length - 1);
  const total = raw.reduce((sum, box) => sum + box.height, 0) + gaps;
  const scale = total > available ? Math.max(0.05, (available - gaps) / (total - gaps)) : 1;
  const boxes = raw.map((box) => ({
    text: box.text,
    size: Math.max(TEXT_SIZE_FLOOR, Math.round(floor * scale)),
    height: box.height * scale,
  }));
  let cursor = Math.max(TEXT_TOP_LIMIT, 1 - TEXT_BOTTOM_MARGIN - (boxes.reduce((sum, box) => sum + box.height, 0) + gaps));
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
function textHeight(text, size, height) {
  const charactersPerLine = Math.max(8, Math.floor((CONTENT_WIDTH * DESIGN_WIDTH) / (size * 0.5)));
  const lines = Math.max(1, Math.ceil(text.length / charactersPerLine));
  return (lines * size * TEXT_LINE_HEIGHT) / height;
}

/** Spreads assets above the text block, at most three to a row, never overlapping it. */
function layoutAssets(assets, height, textBlockTop) {
  if (!assets.length) return [];
  const areaTop = ASSET_TOP_MARGIN;
  const areaBottom = Math.max(areaTop + 0.08, textBlockTop - 0.04);
  const areaHeight = areaBottom - areaTop;
  const rows = chunk(assets, ASSET_ROW_MAX);
  const rowHeight = (areaHeight - ASSET_GAP * (rows.length - 1)) / rows.length;
  const placed = [];
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
    const rowWidth = sized.reduce((sum, box) => sum + box.width, 0) + ASSET_GAP * (row.length - 1);
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
export function toComposition(project) {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    ratio: project.ratio,
    slides: (project.slides || []).map((slide) => ({
      name: slide.name,
      background: slide.backgroundItemId || null,
      assets: (slide.overlays || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map((overlay) => overlay.itemId),
      texts: (slide.texts || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map((text) => text.text),
    })),
  };
}

export function validateComposition(slides) {
  if (!Array.isArray(slides) || !slides.length) {
    throw new HttpError(400, "A slideshow needs at least one slide.");
  }
  if (slides.length > 100) throw new HttpError(400, "A slideshow can hold at most 100 slides.");
  slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") throw new HttpError(400, `Slide ${index + 1} is not an object.`);
    if (!slide.background) throw new HttpError(400, `Slide ${index + 1} needs a background library item id.`);
  });
  return slides;
}

function sameComposition(slide, backgroundId, assetIds, texts) {
  if (slide.backgroundItemId !== backgroundId) return false;
  const currentAssets = (slide.overlays || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map((overlay) => overlay.itemId);
  const currentTexts = (slide.texts || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map((text) => text.text);
  return sameList(currentAssets, assetIds) && sameList(currentTexts, texts);
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRatio(a, b) {
  return Boolean(a) && Math.abs(a.w / a.h - b.w / b.h) < 0.0005;
}

function normalizeRatio(ratio) {
  const w = Number(ratio?.w);
  const h = Number(ratio?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { ...DEFAULT_RATIO };
  if (w / h < 0.4 || w / h > 2.5) throw new HttpError(400, "Keep the ratio between 0.4:1 and 2.5:1.");
  return { w, h };
}

function normalizeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry != null && entry !== "");
}

function chunk(list, size) {
  const rows = [];
  for (let index = 0; index < list.length; index += size) rows.push(list.slice(index, index + size));
  return rows;
}
