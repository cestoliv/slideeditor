import { useEffect } from "react";
import type { EditorStore } from "../store.js";
import { isEditingTextTarget } from "./useLayerClipboard.js";

/*
 * Undo and redo, bound where app.js bound them (app.js:4861-4879): on the
 * document, so they work wherever the reader's focus happens to be.
 *
 * The store has had `undo` and `redo` since Task 13 and nothing in the product
 * called them. That was invisible to every component test, because the store's
 * own tests call the methods directly — a test that reaches for the function
 * cannot see that no one else does.
 */

/**
 * app.js:4863. A field owns its own undo stack, and ⌘Z inside one is the
 * browser's own text undo. Taking it away would make a mistyped word
 * unrecoverable while making the layer history reachable, which is a bad trade.
 * The inline text editor is a `contenteditable`, so this same test covers it.
 */
function ownsItsOwnHistory(target: EventTarget | null): boolean {
  return isEditingTextTarget(target);
}

export function useEditorShortcuts(store: EditorStore): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // app.js:4861 accepts either, so the shortcut works on both platforms.
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      if (ownsItsOwnHistory(event.target)) return;
      event.preventDefault();
      // app.js:4866 and app.js:4873. Shift+Z and Y are both redo.
      if (key === "y" || event.shiftKey) store.redo();
      else store.undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [store]);
}
