import type { SlideshowStatus } from "@shared/schema/index.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import styles from "./StatusSwitch.module.css";

/*
 * The draft / ready / published control in the editor header. Ported from
 * SLIDESHOW_STATUSES (app.js:17-21), its markup (app.js:1209-1214) and
 * setSlideshowStatus (app.js:933-952).
 *
 * The write does not go through the save. Status is not part of the document,
 * the server writes it without the version guard, and it leaves the version
 * alone (src/server/services/projects.ts), so marking something ready can never
 * make an open editor's next save conflict. EditorStore.setStatus is the only
 * supported way to say it, and it also owns the rollback when the server
 * refuses (app.js:947-951).
 */

const SLIDESHOW_STATUSES: readonly { id: SlideshowStatus; label: string }[] = [
  { id: "draft", label: "Draft" },
  { id: "ready", label: "Ready" },
  { id: "published", label: "Published" },
];

export type StatusSwitchProps = {
  store: EditorStore;
};

export function StatusSwitch({ store }: StatusSwitchProps) {
  const status = useEditor(store, (state) => state.project.status);

  return (
    <div className={styles.switch} role="group" aria-label="Slideshow status">
      {SLIDESHOW_STATUSES.map((option) => (
        <button
          key={option.id}
          className={styles.option}
          type="button"
          aria-pressed={status === option.id}
          onClick={() => {
            // The promise is deliberately dropped. setStatus never rejects: it
            // rolls the label back and reports through the store's onError.
            void store.setStatus(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
