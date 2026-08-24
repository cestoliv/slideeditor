import { useCallback } from "react";
import {
  OUTPUT_WIDTH,
  PHOTO_ZOOM_MAX,
  PHOTO_ZOOM_MIN,
  clamp,
  constrainImagePosition,
  outputHeight,
} from "@shared/geometry/index.js";
import type { Ratio, Slide, SlideDocument } from "@shared/schema/index.js";
import { Button, Slider } from "../../../design/index.js";
import type { EditorStore } from "../store.js";
import { useHistoryEntry } from "./history.js";
import styles from "./Inspector.module.css";

/*
 * Photo settings, ported from app.js:1955-1962, app.js:2465-2482.
 *
 * The pan is re-clamped against the export canvas rather than the stage. Every
 * length getImageLayout returns is measured in canvas fractions, so the cap it
 * computes is the same at any zoom, and this panel needs no stage rectangle.
 */

export type SlideInspectorProps = {
  store: EditorStore;
  slide: Slide;
  ratio: Ratio;
};

export function SlideInspector({ store, slide, ratio }: SlideInspectorProps) {
  const entry = useHistoryEntry(store);
  const slideId = slide.id;
  const scale = slide.imageScale || 1;
  const canvasHeight = outputHeight(ratio);

  const writeSlide = useCallback(
    (change: (live: Slide) => void, history: boolean) => {
      store.mutate(
        (document: SlideDocument) => {
          const live = document.slides.find((item) => item.id === slideId);
          if (live === undefined) return;
          change(live);
        },
        { history },
      );
    },
    [slideId, store],
  );

  return (
    <>
      <div className={styles.group}>
        <div className={styles.label}>
          <span>Zoom</span>
          <output htmlFor="photo-zoom">{`${String(Math.round(scale * 100))}%`}</output>
        </div>
        <Slider
          id="photo-zoom"
          min={PHOTO_ZOOM_MIN}
          max={PHOTO_ZOOM_MAX}
          step={0.01}
          value={scale}
          aria-label="Photo zoom"
          aria-valuetext={`${String(Math.round(scale * 100))} percent`}
          onValueChange={(value) => {
            entry.begin();
            writeSlide((live) => {
              live.imageScale = clamp(value || 1, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
              // app.js:2470. Zooming out shrinks the overhang, so a pan that was
              // legal a moment ago has to come back inside it.
              const held = constrainImagePosition(live, OUTPUT_WIDTH, canvasHeight);
              live.imageX = held.imageX;
              live.imageY = held.imageY;
            }, false);
          }}
          onValueCommit={entry.end}
        />
      </div>
      <Button
        className={styles.reset ?? ""}
        variant="ghost"
        onClick={() => {
          // app.js:2478-2482 recorded nothing here, which made the one
          // irreversible control on the panel. It takes an entry of its own.
          writeSlide((live) => {
            live.imageScale = 1;
            live.imageX = 0;
            live.imageY = 0;
          }, true);
        }}
      >
        Reset photo
      </Button>
    </>
  );
}
