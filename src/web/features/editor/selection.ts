import type { Overlay, Slide, TextLayer } from "@shared/schema/index.js";

/** The two things a slide stacks (app.js:570-573). */
export type LayerKind = "overlay" | "text";

/** app.js:371-373. The string form a selection is stored as. */
export type LayerKey = `${LayerKind}:${string}`;

/**
 * The four z-order moves the layer menu offers (app.js:653-657). The brief
 * names these "forward" and "backward"; the running code and its only caller
 * both say "up" and "down", so those are the names here.
 */
export type LayerMove = "front" | "up" | "down" | "back";

export type SlideLayer =
  | { kind: "overlay"; item: Overlay; key: LayerKey }
  | { kind: "text"; item: TextLayer; key: LayerKey };

export type LayerSelection = {
  keys: LayerKey[];
  primary: LayerKey | null;
};

export function layerKey(kind: LayerKind, id: string): LayerKey {
  return `${kind}:${id}`;
}

/**
 * app.js:375-378, splitting on the first colon so an id may contain one. The
 * old version returns a nonsense kind for a key with no colon at all, which
 * then matches nothing; answering null instead lets a caller drop it on sight.
 */
export function parseLayerKey(key: string): { kind: LayerKind; id: string } | null {
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const kind = key.slice(0, separator);
  if (kind !== "overlay" && kind !== "text") return null;
  return { kind, id: key.slice(separator + 1) };
}

// app.js:573 reads z through Number(), so a string or a missing value sorts as 0.
function orderOf(item: { z?: number | undefined }): number {
  return Number(item.z) || 0;
}

/**
 * Every layer on the slide in one z-order, back to front (app.js:570-574).
 * Overlays precede texts before the sort, so layers sharing a z keep the order
 * the document stores them in.
 */
export function slideItems(slide: Slide | null | undefined): SlideLayer[] {
  if (!slide) return [];
  const overlays: SlideLayer[] = slide.overlays.map((item) => ({
    kind: "overlay",
    item,
    key: layerKey("overlay", item.id),
  }));
  const texts: SlideLayer[] = slide.texts.map((item) => ({
    kind: "text",
    item,
    key: layerKey("text", item.id),
  }));
  return [...overlays, ...texts].sort((a, b) => orderOf(a.item) - orderOf(b.item));
}

/** app.js:576-580. The z a newly added layer takes, on top of everything. */
export function nextLayerZ(slide: Slide | null | undefined): number {
  const items = slideItems(slide);
  if (!items.length) return 1;
  return Math.max(...items.map((entry) => orderOf(entry.item))) + 1;
}

/**
 * app.js:402-412. Drops duplicates, drops keys the slide no longer holds, and
 * settles on a primary that survived the filter. A selection left over from a
 * deleted layer therefore vanishes rather than pointing at nothing.
 */
export function setLayerSelection(
  slide: Slide | null | undefined,
  keys: readonly LayerKey[],
  primaryKey: LayerKey | null = keys.at(-1) ?? null,
): LayerSelection {
  const valid = new Set(slideItems(slide).map((entry) => entry.key));
  const selected = [...new Set(keys)].filter((key) => valid.has(key));
  const primary =
    primaryKey !== null && selected.includes(primaryKey)
      ? primaryKey
      : (selected.at(-1) ?? null);
  return { keys: selected, primary };
}

/** app.js:414-417. */
export function selectOnlyLayer(
  slide: Slide | null | undefined,
  kind: LayerKind,
  id: string,
): LayerSelection {
  const key = layerKey(kind, id);
  return setLayerSelection(slide, [key], key);
}

/** app.js:419-424. A layer already in the selection leaves it, and the rest keep their order. */
export function toggleLayerSelection(
  slide: Slide | null | undefined,
  current: readonly LayerKey[],
  kind: LayerKind,
  id: string,
): LayerSelection {
  const key = layerKey(kind, id);
  if (current.includes(key)) {
    return setLayerSelection(
      slide,
      current.filter((item) => item !== key),
    );
  }
  return setLayerSelection(slide, [...current, key], key);
}

/** app.js:384-386. */
export function isLayerSelected(
  keys: readonly LayerKey[],
  kind: LayerKind,
  id: string,
): boolean {
  return keys.includes(layerKey(kind, id));
}

/**
 * app.js:388-398, in selection order rather than z-order, because a drag reads
 * the primary layer off the end of this list.
 */
export function selectedLayers(
  slide: Slide | null | undefined,
  keys: readonly LayerKey[],
): SlideLayer[] {
  const items = slideItems(slide);
  return keys.flatMap((key) => items.filter((entry) => entry.key === key));
}

// app.js:605-607 and app.js:620-622. Rewriting every z as its position keeps the
// order dense at 1..n, which is what makes a later single-step move predictable.
function applyOrder(items: readonly SlideLayer[]): void {
  items.forEach((layer, order) => {
    layer.item.z = order + 1;
  });
}

/**
 * app.js:582-627. Reorders across the one z-order overlays and texts share, and
 * mutates the layers in place. Answers whether the slide was touched.
 *
 * A move on a layer inside the current selection moves the whole selection, and
 * that path is a different algorithm: front and back partition the merged list,
 * while up and down walk it once swapping adjacent pairs. The walk runs
 * backwards for up and forwards for down so the selected layers keep their
 * relative order instead of piling up against each other.
 */
export function moveLayer(
  slide: Slide | null | undefined,
  kind: LayerKind,
  id: string,
  action: LayerMove,
  selection: readonly LayerKey[] = [],
): boolean {
  if (!slide) return false;
  const items = slideItems(slide);
  const key = layerKey(kind, id);
  const selected = new Set<LayerKey>(selection.includes(key) ? selection : [key]);

  if (selected.size > 1) {
    if (action === "front" || action === "back") {
      const chosen = items.filter((entry) => selected.has(entry.key));
      const remaining = items.filter((entry) => !selected.has(entry.key));
      items.splice(
        0,
        items.length,
        ...(action === "front" ? [...remaining, ...chosen] : [...chosen, ...remaining]),
      );
    } else if (action === "up") {
      for (let index = items.length - 2; index >= 0; index -= 1) {
        const current = items[index];
        const next = items[index + 1];
        if (!current || !next) continue;
        if (selected.has(current.key) && !selected.has(next.key)) {
          items[index] = next;
          items[index + 1] = current;
        }
      }
    } else {
      for (let index = 1; index < items.length; index += 1) {
        const current = items[index];
        const previous = items[index - 1];
        if (!current || !previous) continue;
        if (selected.has(current.key) && !selected.has(previous.key)) {
          items[index] = previous;
          items[index - 1] = current;
        }
      }
    }
    applyOrder(items);
    return true;
  }

  const index = items.findIndex((entry) => entry.key === key);
  if (index < 0) return false;
  const [entry] = items.splice(index, 1);
  if (!entry) return false;
  if (action === "front") items.push(entry);
  else if (action === "back") items.unshift(entry);
  // Clamping to the ends is what makes a move on the front-most or back-most
  // layer land it back where it started (app.js:616-617).
  else if (action === "up") items.splice(Math.min(index + 1, items.length), 0, entry);
  else items.splice(Math.max(index - 1, 0), 0, entry);
  applyOrder(items);
  return true;
}
