import { useCallback, useRef } from "react";
import type { EditorStore } from "../store.js";

/**
 * One undo entry per gesture, for the inspector's continuous controls.
 *
 * app.js opened an entry on pointerdown and then mutated freely on every input
 * event (app.js:2367-2369, app.js:2400-2401), so a drag across the size slider
 * undoes in one step rather than in forty. EditorStore.transaction cannot serve
 * that, because a gesture spans many events and transaction runs one
 * synchronous body, so the entry is opened and closed by hand here.
 *
 * `begin` is idempotent within a gesture: the second call inside one drag adds
 * nothing, which is exactly what makes the drag a single entry.
 */
export type HistoryEntry = {
  /** Opens the entry if one is not already open. Call before the first write. */
  begin: () => void;
  /** Closes it, so the next gesture starts a new one. */
  end: () => void;
};

export function useHistoryEntry(store: EditorStore): HistoryEntry {
  const open = useRef(false);

  const begin = useCallback(() => {
    if (open.current) return;
    open.current = true;
    // app.js:4096 records the same way: an empty mutation whose only job is to
    // put the document as it stands on the undo stack. It saves nothing,
    // because the write that follows schedules its own.
    store.mutate(() => undefined, { history: true, save: false });
  }, [store]);

  const end = useCallback(() => {
    open.current = false;
  }, []);

  return { begin, end };
}
