import { clamp, constrainOverlay } from "@shared/geometry/index.js";
import type { AssetSize } from "@shared/geometry/index.js";
import type { LibraryItem, Overlay, Ratio, TextLayer } from "@shared/schema/index.js";
import type { EditorStore } from "../store.js";
import { layerKey, nextLayerZ, slideItems } from "../selection.js";
import type { LayerKey } from "../selection.js";
import { slideOf } from "./actions.js";

/*
 * Copying and pasting layers, ported from app.js:4597-4756.
 *
 * The two constants are deliberately unchanged, so a layer copied in the old
 * app still pastes in this one.
 *
 * The handshake is the interesting part. Browsers strip a custom MIME type when
 * the clipboard crosses a tab, so a copy writes three payloads: the real one
 * under the custom type, a sentinel under text/plain carrying a token, and a
 * mirror in localStorage keyed by nothing at all. A paste resolves by token,
 * in memory first, then localStorage, then whatever the clipboard still holds.
 * Without the token there is no way to tell a stale mirror from a fresh copy.
 */

export const CLIPBOARD_LAYER_TYPE = "application/x-slide-studio-layer";
export const CLIPBOARD_STORAGE_KEY = "slide-studio-layer-clipboard";
export const CLIPBOARD_TEXT_PREFIX = "slide-studio-layer:";

/** app.js:4681. How far a paste lands from the layer it was copied from. */
export const PASTE_OFFSET = 0.03;

export type CopiedLayer =
  | { kind: "text"; item: TextLayer }
  /** An overlay carries its asset, so a paste resolves the image without the library. */
  | { kind: "overlay"; item: Overlay; asset: LibraryItem };

export type CopiedLayers = { token: string; layers: CopiedLayer[] };

/** app.js:4597-4611. Enough of a shape check that a foreign payload is refused. */
export function isCopiedLayer(value: unknown): value is CopiedLayers {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { token?: unknown; layers?: unknown };
  if (typeof candidate.token !== "string" || candidate.token === "") return false;
  if (!Array.isArray(candidate.layers) || candidate.layers.length === 0) return false;
  return candidate.layers.every((layer: unknown) => {
    if (typeof layer !== "object" || layer === null) return false;
    const entry = layer as { kind?: unknown; item?: unknown };
    return (
      (entry.kind === "text" || entry.kind === "overlay") &&
      typeof entry.item === "object" &&
      entry.item !== null
    );
  });
}

/** app.js:4613-4621. Anything that does not start with a brace is not ours. */
export function parseCopiedLayer(value: string | null | undefined): CopiedLayers | null {
  if (value == null || !value.trim().startsWith("{")) return null;
  try {
    const copied: unknown = JSON.parse(value);
    return isCopiedLayer(copied) ? copied : null;
  } catch {
    return null;
  }
}

/** The three payloads a copy writes (app.js:4641-4660). */
export type ClipboardWriter = Pick<DataTransfer, "setData">;

export type ClipboardReader = Pick<DataTransfer, "getData"> & {
  files?: FileList | null;
  items?: DataTransferItemList | null;
};

/**
 * The in-memory half of the handshake.
 *
 * A class rather than a module global, because two editors in one page would
 * otherwise share one slot, and a test would have to reach into module state to
 * reset it.
 */
export class LayerClipboard {
  private held: CopiedLayers | null = null;

  constructor(private readonly storage: Storage | null = safeStorage()) {}

  /** app.js:4623-4630. Mirrored so another tab can resolve the same token. */
  remember(copied: CopiedLayers): void {
    this.held = copied;
    try {
      this.storage?.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(copied));
    } catch (error) {
      console.warn("Could not share the copied layer with other tabs.", error);
    }
  }

  /**
   * app.js:4632-4639. The mirror is only trusted when its token matches.
   *
   * This comparison is the whole cross-tab handshake. Another tab's copy
   * overwrites the mirror, so without it a paste of any sentinel at all would
   * resolve to whatever the mirror last held. Pinned by "refuses a sentinel
   * whose token the mirror does not match".
   */
  stored(token: string): CopiedLayers | null {
    try {
      const copied = parseCopiedLayer(this.storage?.getItem(CLIPBOARD_STORAGE_KEY));
      return copied !== null && copied.token === token ? copied : null;
    } catch {
      return null;
    }
  }

  /** app.js:4662-4676. In memory, then the mirror, then the clipboard itself. */
  resolve(data: ClipboardReader | null): CopiedLayers | null {
    if (data === null) return null;
    const raw = data.getData(CLIPBOARD_LAYER_TYPE);
    const fromClipboard = parseCopiedLayer(raw);
    let token = fromClipboard?.token ?? raw;
    if (token === "") {
      const text = data.getData("text/plain");
      if (text.startsWith(CLIPBOARD_TEXT_PREFIX)) {
        token = text.slice(CLIPBOARD_TEXT_PREFIX.length);
      }
    }
    if (token === "") return null;
    if (token === this.held?.token) return this.held;
    /*
     * app.js:4675 compares the token a second time here. That comparison cannot
     * fail: stored() already refused a mirror under any other token, and a
     * payload parsed off the clipboard supplied `token` itself two lines above.
     * A check no test can kill is one the next reader deletes without noticing,
     * so the reachable one is kept and this one is not carried over.
     */
    const copied = this.stored(token) ?? fromClipboard;
    if (copied === null) return null;
    this.held = copied;
    return copied;
  }

  /**
   * app.js:4740. The copy is replaced by what was just pasted, so a second
   * paste cascades another 0.03 rather than landing back on the first.
   */
  replace(copied: CopiedLayers): void {
    this.held = copied;
  }

  peek(): CopiedLayers | null {
    return this.held;
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // A browser with site data blocked throws on the accessor itself, so the
    // cross-tab half is simply unavailable rather than fatal.
    return null;
  }
}

export const layerClipboard = new LayerClipboard();

export type CopyResult = { copied: CopiedLayers; message: string } | null;

/**
 * Builds the payload for the current selection and writes all three copies
 * (app.js:4641-4660). An overlay whose asset cannot be resolved is dropped,
 * because a paste of it could never find an image.
 */
export function copySelectedLayers(
  store: EditorStore,
  assetOf: (itemId: string) => LibraryItem | null,
  clipboard: LayerClipboard,
  writer: ClipboardWriter | null,
): CopyResult {
  const state = store.getSnapshot();
  const slide =
    state.project.slides.find((item) => item.id === state.activeSlideId) ?? null;
  if (slide === null) return null;
  const selected = new Set(state.selection);
  const layers: CopiedLayer[] = slideItems(slide)
    .filter((entry) => selected.has(entry.key))
    .flatMap((entry): CopiedLayer[] => {
      if (entry.kind === "text") return [{ kind: "text", item: { ...entry.item } }];
      const asset = assetOf(entry.item.itemId);
      return asset === null
        ? []
        : [{ kind: "overlay", item: { ...entry.item }, asset: { ...asset } }];
    });
  if (layers.length === 0) return null;

  const copied: CopiedLayers = { token: crypto.randomUUID(), layers };
  clipboard.remember(copied);
  writer?.setData(CLIPBOARD_LAYER_TYPE, JSON.stringify(copied));
  writer?.setData("text/plain", `${CLIPBOARD_TEXT_PREFIX}${copied.token}`);
  return { copied, message: copyMessage(layers) };
}

function copyMessage(layers: readonly CopiedLayer[]): string {
  if (layers.length !== 1) return `${String(layers.length)} layers copied`;
  return layers[0]?.kind === "overlay" ? "Asset copied" : "Text copied";
}

function pasteMessage(layers: readonly CopiedLayer[]): string {
  if (layers.length !== 1) return `${String(layers.length)} layers pasted`;
  return layers[0]?.kind === "overlay" ? "Asset pasted" : "Text pasted";
}

export type PasteResult = { keys: LayerKey[]; message: string } | null;

/**
 * Inserts a copied payload onto the active slide (app.js:4678-4744).
 *
 * The whole insert is one undo entry, and the payload is rewritten to what was
 * inserted, so pasting three times walks the layer down the slide instead of
 * stacking three copies on one spot.
 */
export function pasteCopiedLayers(
  store: EditorStore,
  copied: CopiedLayers,
  clipboard: LayerClipboard,
  assetOf: (itemId: string) => AssetSize | null,
  ratio: Ratio,
): PasteResult {
  const state = store.getSnapshot();
  const activeSlideId = state.activeSlideId;
  if (activeSlideId === null || copied.layers.length === 0) return null;
  // app.js:4683. An overlay with no asset snapshot could not resolve an image,
  // so the whole paste is refused rather than half applied.
  if (copied.layers.some((layer) => layer.kind === "overlay" && !layer.asset)) {
    return null;
  }

  const pasted: CopiedLayer[] = [];
  const keys: LayerKey[] = [];
  store.mutate((document) => {
    const slide = slideOf(document, activeSlideId);
    if (slide === null) return;
    let z = nextLayerZ(slide);
    for (const layer of copied.layers) {
      const id = crypto.randomUUID();
      if (layer.kind === "overlay") {
        // The live library wins over the snapshot, so a pasted overlay follows
        // an asset that has been re-measured since the copy.
        const live = assetOf(layer.item.itemId) ?? layer.asset;
        const overlay = constrainOverlay(
          {
            ...layer.item,
            id,
            x: layer.item.x + PASTE_OFFSET,
            y: layer.item.y + PASTE_OFFSET,
            z,
          },
          live,
          ratio,
        );
        slide.overlays.push(overlay);
        pasted.push({ kind: "overlay", item: { ...overlay }, asset: layer.asset });
        keys.push(layerKey("overlay", id));
      } else {
        const text: TextLayer = {
          ...layer.item,
          id,
          x: clamp(layer.item.x + PASTE_OFFSET, 0, 1 - layer.item.width),
          y: clamp(layer.item.y + PASTE_OFFSET, 0, 1 - layer.item.height),
          z,
        };
        slide.texts.push(text);
        pasted.push({ kind: "text", item: { ...text } });
        keys.push(layerKey("text", id));
      }
      z += 1;
    }
  });
  if (keys.length === 0) return null;
  clipboard.replace({ token: copied.token, layers: pasted });
  store.select(keys);
  return { keys, message: pasteMessage(pasted) };
}

/** app.js:4731-4734, the same test the library upload uses. */
function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name)
  );
}

/**
 * The image files on a clipboard or a drag (app.js:4736-4756).
 *
 * `files` is checked first and `items` second, because Safari populates only
 * one of the two depending on where the image came from.
 */
export function clipboardImageFiles(data: ClipboardReader | null): File[] {
  if (data === null) return [];
  const listed = data.files === undefined || data.files === null ? [] : [...data.files];
  const direct = listed.filter(isImageFile);
  if (direct.length > 0) return direct;
  if (data.items === undefined || data.items === null) return [];
  return [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImageFile(file));
}
