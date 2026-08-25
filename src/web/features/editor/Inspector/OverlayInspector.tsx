import { useCallback } from "react";
import type { LibraryItem, Overlay, SlideDocument } from "@shared/schema/index.js";
import { Input, Slider } from "../../../design/index.js";
import type { EditorStore } from "../store.js";
import { useHistoryEntry } from "./history.js";
import styles from "./Inspector.module.css";

/*
 * The overlay arm of the inspector, ported from app.js:1963-1973 and
 * app.js:2483-2497.
 *
 * app.js recorded no undo entry for either rotation control, which left the one
 * control on this panel that cannot be undone. It takes the same gesture entry
 * every other slider here takes; a hole in the undo stack is not worth porting.
 */

export type OverlayInspectorProps = {
  store: EditorStore;
  overlay: Overlay;
  /** The library item behind it, for the file name (app.js:1966). */
  asset: LibraryItem | null;
};

/** app.js:2486. Any angle folds back into a single turn. */
function wrapRotation(value: number | string): number {
  return (((Number(value) || 0) % 360) + 360) % 360;
}

export function OverlayInspector({ store, overlay, asset }: OverlayInspectorProps) {
  const entry = useHistoryEntry(store);
  const overlayId = overlay.id;
  const rotation = Math.round(overlay.rotation || 0);

  const setRotation = useCallback(
    (value: number | string) => {
      const next = wrapRotation(value);
      const activeSlideId = store.getSnapshot().activeSlideId;
      store.mutate(
        (document: SlideDocument) => {
          const live = document.slides
            .find((slide) => slide.id === activeSlideId)
            ?.overlays.find((item) => item.id === overlayId);
          if (live === undefined) return;
          live.rotation = next;
        },
        { history: false },
      );
    },
    [overlayId, store],
  );

  return (
    <>
      <div className={styles.group}>
        <div className={styles.label}>File</div>
        <p className={styles.assetName}>{asset?.name ?? "Photo"}</p>
      </div>
      <div className={styles.group}>
        <div className={styles.label}>
          <span>Rotate</span>
          <output htmlFor="overlay-rotation">{`${String(rotation)}°`}</output>
        </div>
        <div className={styles.rangeRow}>
          <Slider
            id="overlay-rotation"
            min={0}
            max={359}
            step={1}
            value={rotation}
            aria-label="Rotation in degrees"
            onValueChange={(value) => {
              entry.begin();
              setRotation(value);
            }}
            onValueCommit={entry.end}
          />
          <Input
            inputSize="sm"
            type="number"
            min={0}
            max={359}
            step={1}
            value={rotation}
            aria-label="Rotation in degrees, typed"
            onFocus={entry.begin}
            onBlur={entry.end}
            onChange={(event) => {
              entry.begin();
              setRotation(event.target.value);
            }}
          />
        </div>
      </div>
    </>
  );
}
