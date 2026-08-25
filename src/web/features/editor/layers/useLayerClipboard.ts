import { useEffect } from "react";
import type { LibraryItem, Ratio } from "@shared/schema/index.js";
import type { EditorStore } from "../store.js";
import { addOverlayFromAsset } from "./actions.js";
import {
  clipboardImageFiles,
  copySelectedLayers,
  pasteCopiedLayers,
} from "./clipboard.js";
import type { LayerClipboard } from "./clipboard.js";

/*
 * The document copy and paste listeners, ported from app.js:4818-4821 and the
 * two handlers they call.
 */

/** app.js:4593-4595. A field owns its own clipboard, so the layers stay out of it. */
export function isEditingTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable]") !== null
  );
}

export type LayerClipboardOptions = {
  store: EditorStore;
  ratio: Ratio;
  assetOf: (itemId: string) => LibraryItem | null;
  clipboard: LayerClipboard;
  /** True while the inline text editor is open, which owns the clipboard too. */
  editing: boolean;
  upload?: ((file: File, name: string) => Promise<LibraryItem>) | undefined;
  remember?: ((item: LibraryItem) => void) | undefined;
  toast?: ((message: string) => void) | undefined;
};

export function useLayerClipboard({
  store,
  ratio,
  assetOf,
  clipboard,
  editing,
  upload,
  remember,
  toast,
}: LayerClipboardOptions): void {
  useEffect(() => {
    let busy = false;

    const onCopy = (event: ClipboardEvent) => {
      if (editing || isEditingTextTarget(event.target)) return;
      const result = copySelectedLayers(
        store,
        assetOf,
        clipboard,
        event.clipboardData ?? null,
      );
      if (result === null) return;
      event.preventDefault();
      toast?.(result.message);
    };

    const onPaste = (event: ClipboardEvent) => {
      if (editing || isEditingTextTarget(event.target) || busy) return;
      const copied = clipboard.resolve(event.clipboardData ?? null);
      if (copied !== null) {
        event.preventDefault();
        const result = pasteCopiedLayers(store, copied, clipboard, assetOf, ratio);
        if (result !== null) toast?.(result.message);
        return;
      }
      const files = clipboardImageFiles(event.clipboardData ?? null);
      if (files.length === 0) return;
      event.preventDefault();
      if (upload === undefined) return;
      busy = true;
      void (async () => {
        try {
          const added: LibraryItem[] = [];
          for (const [index, file] of files.entries()) {
            try {
              const item = await upload(
                file,
                files.length > 1 ? `Pasted image ${String(index + 1)}` : "Pasted image",
              );
              remember?.(item);
              added.push(item);
            } catch (error) {
              console.error(error);
            }
          }
          if (added.length === 0) {
            toast?.("That clipboard image couldn’t be added.");
            return;
          }
          added.forEach((item, index) => {
            addOverlayFromAsset(store, item.id, item, ratio, {
              point: { x: 0.5 + index * 0.03, y: 0.5 + index * 0.03 },
              record: index === 0,
              select: index === added.length - 1,
            });
          });
          toast?.(
            `${String(added.length)} ${added.length === 1 ? "image" : "images"} pasted onto the photo`,
          );
        } finally {
          busy = false;
        }
      })();
    };

    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [assetOf, clipboard, editing, ratio, remember, store, toast, upload]);
}
