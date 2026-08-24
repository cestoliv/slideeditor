import type { SaveState } from "./persistence.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import styles from "./SaveIndicator.module.css";

/*
 * Whether the work is on the server. New rather than ported: app.js had no such
 * indicator, only a toast that faded, so once it had gone nothing on screen
 * told a saved slideshow from an unsaved one.
 *
 * Three states, plainly named. "conflict" reads as saved because the only way
 * to reach it is Saver.onConflict having already replaced the document with the
 * server's own copy, which leaves the two in step.
 */

type Look = { label: string; tone: string };

function look(state: SaveState): Look {
  if (state === "saving") return { label: "Saving…", tone: "busy" };
  if (state === "pending") return { label: "Not saved", tone: "unsaved" };
  return { label: "Saved", tone: "saved" };
}

export type SaveIndicatorProps = { store: EditorStore };

export function SaveIndicator({ store }: SaveIndicatorProps) {
  const state = useEditor(store, (snapshot) => snapshot.saveState);
  const { label, tone } = look(state);
  return (
    <span
      className={styles.indicator}
      data-tone={tone}
      data-save-state={state}
      /*
       * A live region, because this changes on its own rather than in answer to
       * anything the reader did. Polite: it must not cut across what they are
       * typing, which is the very thing it is reporting on.
       */
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
