import { useEffect } from "react";
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import type { LibraryItem, Ratio } from "@shared/schema/index.js";
import type { StageRect } from "@shared/geometry/index.js";
import type { EditorStore } from "../store.js";
import { uploadLibraryFile } from "../../library/upload.js";
import { addOverlayFromAsset } from "./actions.js";
import { clipboardImageFiles } from "./clipboard.js";

/*
 * Dropping an asset or an image file onto the slide. Ported from
 * bindAssetLibrary's drag source (app.js:3164-3176), bindStageAssetDrop
 * (app.js:3255-3281), bindImageFileDrops (app.js:3282-3330) and
 * addDroppedAssetsToSlide (app.js:3332-3369).
 *
 * The listeners are on the document and gated on the stage's rectangle, rather
 * than on the stage element, because the stage belongs to another component and
 * the layer stack over it takes no pointer events at all. The rectangle test is
 * the one app.js:3357-3360 already used to decide where a dropped file lands.
 */

/** The drag payload the asset rail writes, unchanged from app.js:3169. */
export const ASSET_DRAG_TYPE = "application/x-slide-asset";

/** The text/plain fallback, for a drag that crosses into another app. */
export const ASSET_DRAG_PREFIX = "asset:";

/**
 * Marks the canvas while an asset drag is over it, so it can light up
 * (app.js:3266 sets `is-drop-target` for the same reason).
 *
 * It is written onto the layer stack's own root, which covers the stage
 * exactly. Nothing here reaches for another component's element, and nothing
 * here selects on a test id.
 */
export const STAGE_DROP_ATTRIBUTE = "data-stage-drop-target";

/**
 * The props an asset rail tile needs so it can be dragged onto the canvas.
 * Exported here rather than in the rail, so the two halves of the contract sit
 * together and cannot drift.
 */
export function assetDragProps(itemId: string): {
  draggable: true;
  onDragStart: (event: ReactDragEvent) => void;
} {
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(ASSET_DRAG_TYPE, itemId);
      event.dataTransfer.setData("text/plain", `${ASSET_DRAG_PREFIX}${itemId}`);
      event.dataTransfer.effectAllowed = "copyMove";
    },
  };
}

/**
 * Puts a dropped or pasted image into the library as an asset
 * (app.js:4758-4762).
 *
 * An image off the clipboard usually arrives with no name at all, so the
 * caller's fallback becomes the library item's name rather than the generic one
 * nameForFile would settle on.
 */
export function uploadAssetFile(file: File, fallbackName: string): Promise<LibraryItem> {
  const named =
    file.name === ""
      ? new File([file], `${fallbackName}.png`, {
          type: file.type === "" ? "image/png" : file.type,
        })
      : file;
  return uploadLibraryFile("asset", named);
}

function assetIdFrom(data: DataTransfer): string | null {
  const payload = data.getData(ASSET_DRAG_TYPE) || data.getData("text/plain");
  if (payload === "") return null;
  return payload.startsWith(ASSET_DRAG_PREFIX)
    ? payload.slice(ASSET_DRAG_PREFIX.length)
    : payload;
}

function carriesAsset(data: DataTransfer | null): boolean {
  return data !== null && [...data.types].includes(ASSET_DRAG_TYPE);
}

function carriesFiles(data: DataTransfer | null): boolean {
  return data !== null && [...data.types].includes("Files");
}

function pointInside(rect: StageRect, clientX: number, clientY: number): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    clientX >= rect.left &&
    clientX <= rect.left + rect.width &&
    clientY >= rect.top &&
    clientY <= rect.top + rect.height
  );
}

export type AssetDropOptions = {
  store: EditorStore;
  ratio: Ratio;
  assetOf: (itemId: string) => LibraryItem | null;
  rectOf: () => StageRect;
  /** The element covering the canvas, which carries the drop-target mark. */
  element: RefObject<HTMLElement | null>;
  /** Puts a dropped file into the library. Absent when uploads are not wired. */
  upload?: ((file: File, name: string) => Promise<LibraryItem>) | undefined;
  /** Folds a freshly uploaded item into the library cache. */
  remember?: ((item: LibraryItem) => void) | undefined;
  toast?: ((message: string) => void) | undefined;
  /** False while the photo is being placed, when layers step aside (app.js:1700). */
  enabled?: boolean | undefined;
};

export function useAssetDrop({
  store,
  ratio,
  assetOf,
  rectOf,
  element,
  upload,
  remember,
  toast,
  enabled = true,
}: AssetDropOptions): void {
  useEffect(() => {
    if (!enabled) return;
    let busy = false;

    const markStage = (hot: boolean) => {
      const canvas = element.current;
      if (canvas === null) return;
      if (hot) canvas.setAttribute(STAGE_DROP_ATTRIBUTE, "true");
      else canvas.removeAttribute(STAGE_DROP_ATTRIBUTE);
    };

    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!carriesAsset(data) && !carriesFiles(data)) return;
      if (!pointInside(rectOf(), event.clientX, event.clientY)) {
        markStage(false);
        return;
      }
      event.preventDefault();
      if (data !== null) data.dropEffect = "copy";
      markStage(true);
    };

    const onDragLeave = () => {
      markStage(false);
    };

    const onDrop = (event: DragEvent) => {
      const data = event.dataTransfer;
      markStage(false);
      const rect = rectOf();
      if (!pointInside(rect, event.clientX, event.clientY)) return;
      const point = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };

      if (carriesAsset(data) && data !== null) {
        event.preventDefault();
        const itemId = assetIdFrom(data);
        if (itemId === null) return;
        const asset = assetOf(itemId);
        if (asset === null) {
          toast?.("That asset is missing.");
          return;
        }
        addOverlayFromAsset(store, itemId, asset, ratio, { point });
        return;
      }

      if (!carriesFiles(data) || data === null) return;
      const files = clipboardImageFiles(data);
      event.preventDefault();
      if (files.length === 0) {
        toast?.("Drop an image file here.");
        return;
      }
      if (upload === undefined || busy) return;
      busy = true;
      void (async () => {
        try {
          const added: LibraryItem[] = [];
          for (const [index, file] of files.entries()) {
            try {
              const item = await upload(
                file,
                files.length > 1 ? `Dropped image ${String(index + 1)}` : "Dropped image",
              );
              remember?.(item);
              added.push(item);
            } catch (error) {
              console.error(error);
            }
          }
          if (added.length === 0) {
            toast?.("Those images couldn’t be added.");
            return;
          }
          added.forEach((item, index) => {
            // app.js:3364. One entry for the batch, and each image a little
            // below the last so the stack is visible rather than one on one.
            addOverlayFromAsset(store, item.id, item, ratio, {
              point: { x: point.x + index * 0.03, y: point.y + index * 0.03 },
              record: index === 0,
              select: index === added.length - 1,
            });
          });
          toast?.(
            `${String(added.length)} ${added.length === 1 ? "image" : "images"} added to the slide`,
          );
        } finally {
          busy = false;
        }
      })();
    };

    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      markStage(false);
    };
  }, [assetOf, element, enabled, ratio, rectOf, remember, store, toast, upload]);
}
