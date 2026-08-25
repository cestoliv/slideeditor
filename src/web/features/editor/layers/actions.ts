import { clamp } from "@shared/geometry/index.js";
import {
  constrainOverlay,
  getOverlayMetrics,
  initialOverlayWidth,
} from "@shared/geometry/index.js";
import type { AssetSize } from "@shared/geometry/index.js";
import type { Overlay, Ratio, Slide, SlideDocument } from "@shared/schema/index.js";
import type { EditorStore } from "../store.js";
import { isLayerSelected, nextLayerZ } from "../selection.js";
import type { LayerKind } from "../selection.js";

/*
 * The layer edits that are not gestures: selecting on a press, deleting,
 * adding a text, and adding an overlay from a library asset. Ported from
 * prepareLayerPointerSelection (app.js:3476-3490), deleteSelectedLayers
 * (app.js:3463-3474), addText (app.js:2949-2985) and addOverlayFromAsset
 * (app.js:3371-3404).
 */

/** app.js:2952-2953. What a freshly added text box measures. */
export const NEW_TEXT_WIDTH = 0.64;
export const NEW_TEXT_HEIGHT = 0.08;

/** app.js:3745-3746 and app.js:4038-4039. How small each kind may be dragged. */
export const OVERLAY_RESIZE_LIMITS = {
  minWidth: 0.04,
  minHeight: 0.025,
  maxWidth: 2.4,
  maxHeight: 2.4,
} as const;

export const TEXT_RESIZE_LIMITS = { minWidth: 0.1, minHeight: 0.045 } as const;

export function slideOf(document: SlideDocument, slideId: string | null): Slide | null {
  return document.slides.find((slide) => slide.id === slideId) ?? null;
}

/**
 * Settles the selection a press lands on, and answers whether a drag may begin
 * (app.js:3476-3490).
 *
 * Returns false for a modifier click, which only toggles, and for a right
 * click, which opens the menu. Without that gate a modifier-click multi-select
 * would also drag the layer it just added.
 */
export function prepareLayerPointerSelection(
  store: EditorStore,
  event: {
    metaKey: boolean;
    ctrlKey: boolean;
    button: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  },
  kind: LayerKind,
  id: string,
): boolean {
  if ((event.metaKey || event.ctrlKey) && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    store.toggleSelect(kind, id);
    return false;
  }
  const state = store.getSnapshot();
  if (isLayerSelected(state.selection, kind, id)) {
    // Already selected, so the press only moves the anchor a multi-selection
    // and the inspector read off (app.js:400-412).
    store.select(state.selection, `${kind}:${id}`);
  } else {
    store.selectOnly(kind, id);
  }
  return event.button !== 2;
}

/**
 * Removes every selected layer (app.js:3463-3474).
 *
 * Crop mode is left without applying, because folding the crop back into an
 * overlay that is about to be deleted would write its geometry out for nothing,
 * and app.js:3467 is explicit about it.
 */
export function deleteSelectedLayers(store: EditorStore): boolean {
  const state = store.getSnapshot();
  if (state.selection.length === 0) return false;
  const keys = new Set(state.selection);
  const activeSlideId = state.activeSlideId;
  store.setCropping(null);
  store.mutate((document) => {
    const slide = slideOf(document, activeSlideId);
    if (slide === null) return;
    slide.texts = slide.texts.filter((text) => !keys.has(`text:${text.id}`));
    slide.overlays = slide.overlays.filter(
      (overlay) => !keys.has(`overlay:${overlay.id}`),
    );
  });
  store.clearSelection();
  return true;
}

/**
 * Takes one library asset off every slide in the slideshow (app.js:3446-3457).
 * The library item itself is untouched: this is "not in this slideshow", not
 * "delete the picture".
 */
export function removeProjectAsset(store: EditorStore, itemId: string): boolean {
  const state = store.getSnapshot();
  const used = state.project.slides.some((slide) =>
    slide.overlays.some((overlay) => overlay.itemId === itemId),
  );
  if (!used) return false;
  store.mutate((document) => {
    for (const slide of document.slides) {
      slide.overlays = slide.overlays.filter((overlay) => overlay.itemId !== itemId);
    }
  });
  return true;
}

/**
 * Every asset the slideshow uses, in the order it first appears
 * (app.js:430-441). A slideshow shows these before it shows the whole library,
 * because the assets already on it are the ones most likely to be reached for
 * again.
 */
export function projectAssetIds(project: {
  slides: readonly { overlays: readonly { itemId: string }[] }[];
}): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const slide of project.slides) {
    for (const overlay of slide.overlays) {
      if (seen.has(overlay.itemId)) continue;
      seen.add(overlay.itemId);
      ids.push(overlay.itemId);
    }
  }
  return ids;
}

/**
 * Moves every selected layer by one step, for the arrow keys.
 *
 * New. app.js bound no arrow keys at all, so a keyboard reader could never move
 * anything on the canvas even once selection was reachable. One press is one
 * undo entry, the way one drag is.
 */
export function nudgeSelection(store: EditorStore, dx: number, dy: number): boolean {
  const state = store.getSnapshot();
  if (state.selection.length === 0) return false;
  const activeSlideId = state.activeSlideId;
  const keys = new Set(state.selection);
  store.mutate((document) => {
    const slide = slideOf(document, activeSlideId);
    if (slide === null) return;
    for (const text of slide.texts) {
      if (!keys.has(`text:${text.id}`)) continue;
      text.x += dx;
      text.y += dy;
    }
    for (const overlay of slide.overlays) {
      if (!keys.has(`overlay:${overlay.id}`)) continue;
      overlay.x += dx;
      overlay.y += dy;
    }
  });
  return true;
}

export type StagePoint = { x: number; y: number };

/**
 * Adds a text layer, centred on a point when one is given (app.js:2949-2985).
 * Returns its id, so the caller can open the inline editor on it.
 */
export function addTextLayer(
  store: EditorStore,
  point: StagePoint | null,
): string | null {
  const state = store.getSnapshot();
  const activeSlideId = state.activeSlideId;
  if (activeSlideId === null) return null;
  const id = crypto.randomUUID();
  let added = false;
  store.mutate((document) => {
    const slide = slideOf(document, activeSlideId);
    if (slide === null) return;
    slide.texts.push({
      id,
      text: "Your text",
      x:
        point === null
          ? 0.18
          : clamp(point.x - NEW_TEXT_WIDTH / 2, 0, 1 - NEW_TEXT_WIDTH),
      y:
        point === null
          ? 0.42
          : clamp(point.y - NEW_TEXT_HEIGHT / 2, 0, 1 - NEW_TEXT_HEIGHT),
      width: NEW_TEXT_WIDTH,
      height: NEW_TEXT_HEIGHT,
      size: 64,
      style: "plain",
      color: "#FFFFFF",
      background: "white",
      // app.js:2965 writes "lines" here where the schema's own default is
      // "full". A text added in the editor is the one that says lines.
      backgroundShape: "lines",
      align: "center",
      rotation: 0,
      z: nextLayerZ(slide),
    });
    added = true;
  });
  if (!added) return null;
  store.selectOnly("text", id);
  return id;
}

export type AddOverlayOptions = {
  /** Where the overlay's centre lands, in canvas fractions. */
  point?: StagePoint | null | undefined;
  /** False while several overlays are added inside one undo entry. */
  record?: boolean | undefined;
  /** False to leave the selection alone, for the last of a batch to set. */
  select?: boolean | undefined;
};

/**
 * Places a library asset on the active slide (app.js:3371-3404). The overlay
 * starts at the asset's own pixel size, shrunk to fit, so a small image is
 * never blown up and a large one never fills the slide.
 */
export function addOverlayFromAsset(
  store: EditorStore,
  itemId: string,
  asset: AssetSize | null,
  ratio: Ratio,
  options: AddOverlayOptions = {},
): string | null {
  const { point = null, record = true, select = true } = options;
  const state = store.getSnapshot();
  const activeSlideId = state.activeSlideId;
  if (activeSlideId === null || asset === null) return null;
  const id = crypto.randomUUID();
  let added = false;
  store.mutate(
    (document) => {
      const slide = slideOf(document, activeSlideId);
      if (slide === null) return;
      const base: Overlay = constrainOverlay(
        {
          id,
          itemId,
          x: 0.33,
          y: 0.36,
          width: initialOverlayWidth(asset, ratio),
          rotation: 0,
          cropX: 0,
          cropY: 0,
          cropW: 1,
          cropH: 1,
          z: nextLayerZ(slide),
        },
        asset,
        ratio,
      );
      if (point !== null) {
        const metrics = getOverlayMetrics(base, asset, { ratio });
        base.x = point.x - metrics.width / 2;
        base.y = point.y - metrics.height / 2;
      }
      slide.overlays.push(point === null ? base : constrainOverlay(base, asset, ratio));
      added = true;
    },
    { history: record },
  );
  if (!added) return null;
  if (select) store.selectOnly("overlay", id);
  return id;
}
