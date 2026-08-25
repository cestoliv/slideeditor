import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  PHOTO_ZOOM_MAX,
  PHOTO_ZOOM_MIN,
  clamp,
  constrainImagePosition,
  getImageLayout,
  zoomPhotoAtPoint,
} from "@shared/geometry/index.js";
import type { LibraryIndex } from "../../app/useLibrary.js";
import { activeSlideOf, useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import { layerKey } from "./selection.js";
import type { LayerKey, LayerKind } from "./selection.js";
import { useStageSize } from "./useStageSize.js";
import styles from "./Stage.module.css";

/*
 * The slide canvas and the surface it floats on. Ported from renderStage
 * (app.js:1695-1720), sizeStage (app.js:2584-2618), setCanvasZoom
 * (app.js:2619-2643), beginImageDrag (app.js:4093-4123) and
 * beginMarqueeSelection (app.js:2526-2583).
 *
 * The layers themselves are Task 15's and arrive as children. They have to
 * carry data-layer-kind and data-layer-id, because the marquee hit-tests the
 * DOM the way app.js:2557-2566 did, and those attributes are the contract that
 * replaces its .text-box and .overlay-box class selectors.
 */

/** app.js:2551. Under this a drag is a click, and a click restores the old selection. */
const MARQUEE_THRESHOLD = 3;

/** app.js:2246. One wheel notch, before the delta mode is folded in. */
const WHEEL_ZOOM_RATE = 0.0015;

/** app.js:2211. What the plus and minus buttons step by. */
const ZOOM_BUTTON_STEP = 1.2;

/** app.js:2281. A scroll burst is one undo entry, not one per notch. */
const PHOTO_ZOOM_HISTORY_MS = 250;

export type StageProps = {
  store: EditorStore;
  /** Resolves a slide's backgroundItemId to the image behind it (app.js:288-296). */
  library: LibraryIndex;
  /** app.js:1700. The photo pans and zooms, and the layers step aside. */
  photoAdjust?: boolean;
  /** The actions column beside the stage, filled by Tasks 15 and 16. */
  actions?: ReactNode;
  /** The ratio button in the readout under the stage, which is Task 16's. */
  ratioControl?: ReactNode;
  /**
   * Called instead of clearing the selection when a click lands on the surface
   * while an overlay is being cropped. Folding a crop back into an overlay
   * needs the asset's pixel size, which the stage has no reason to hold, so
   * Task 15 owns that step (app.js:2299-2306).
   */
  onFinishCrop?: (() => void) | undefined;
  /** The layer stack. Task 15 renders it. */
  children?: ReactNode;
};

/** app.js:2244-2249. A line or a page of scroll is worth more than a pixel of it. */
function wheelDistance(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * pageHeight;
  return event.deltaY;
}

/**
 * app.js:2222. A click on a control is that control's, never the marquee's.
 *
 * The layer boxes stand in for the old .text-box and .overlay-box selectors,
 * and [data-canvas-actions] for .canvas-actions: the actions column is excluded
 * whole, not just its buttons, so a press on the gap between two of them does
 * not start a marquee behind the toolbar.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      "button, input, textarea, select, a, [contenteditable], [data-layer-kind], [data-canvas-actions]",
    ) !== null
  );
}

export function Stage({
  store,
  library,
  photoAdjust = false,
  actions,
  ratioControl,
  onFinishCrop,
  children,
}: StageProps) {
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const photoZoomTimer = useRef<number | null>(null);

  const slide = useEditor(store, activeSlideOf);
  const ratio = useEditor(store, (state) => state.project.ratio);
  const { width, height, zoom, setZoom, elements } = useStageSize(ratio);
  const {
    workspace: workspaceRef,
    inner: innerRef,
    composition: compositionRef,
    actions: actionsRef,
    stage: stageRef,
  } = elements;

  const background =
    slide === null ? null : (library.get(slide.backgroundItemId) ?? null);

  /*
   * The viewport zoom, on ctrl or command and a wheel. React attaches its own
   * wheel listener passively, so preventDefault from an onWheel prop is refused
   * and the page scrolls under the gesture; this one is bound by hand for that
   * reason alone (app.js:2241 does the same).
   */
  useEffect(() => {
    const surface = workspaceRef.current;
    if (surface === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const distance = wheelDistance(event, stageRef.current?.clientHeight ?? 1);
      setZoom((current) => current * Math.exp(-distance * WHEEL_ZOOM_RATE), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("wheel", onWheel);
    };
  }, [setZoom, stageRef, workspaceRef]);

  /*
   * The photo's own zoom, on a plain wheel in photo mode (app.js:2266-2292).
   * One scroll burst is one undo entry, held open by a trailing timer.
   */
  useEffect(() => {
    const stageElement = stageRef.current;
    if (stageElement === null || !photoAdjust) return;
    const onWheel = (event: WheelEvent) => {
      if (event.metaKey || event.ctrlKey) return;
      const current = store.getSnapshot();
      const target = activeSlideOf(current);
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      const distance = wheelDistance(event, stageElement.clientHeight);
      const currentScale = target.imageScale || 1;
      const nextScale = clamp(
        currentScale * Math.exp(-distance * WHEEL_ZOOM_RATE),
        PHOTO_ZOOM_MIN,
        PHOTO_ZOOM_MAX,
      );
      if (Math.abs(nextScale - currentScale) < 0.0001) return;
      const rect = stageElement.getBoundingClientRect();
      const zoomed = zoomPhotoAtPoint(target, nextScale, event.clientX, event.clientY, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
      const opensEntry = photoZoomTimer.current === null;
      if (photoZoomTimer.current !== null) window.clearTimeout(photoZoomTimer.current);
      photoZoomTimer.current = window.setTimeout(() => {
        photoZoomTimer.current = null;
      }, PHOTO_ZOOM_HISTORY_MS);
      store.mutate(
        (document) => {
          const live = document.slides.find((item) => item.id === target.id);
          if (live === undefined) return;
          live.imageScale = zoomed.imageScale;
          live.imageX = zoomed.imageX;
          live.imageY = zoomed.imageY;
        },
        { history: opensEntry },
      );
    };
    stageElement.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stageElement.removeEventListener("wheel", onWheel);
    };
  }, [photoAdjust, stageRef, store]);

  useEffect(
    () => () => {
      if (photoZoomTimer.current !== null) window.clearTimeout(photoZoomTimer.current);
    },
    [],
  );

  /* beginImageDrag, app.js:4093-4123. */
  const beginImageDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const stageElement = stageRef.current;
      const target = activeSlideOf(store.getSnapshot());
      if (stageElement === null || target === null) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = stageElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // app.js:4096 records at pointer down so the whole drag undoes in one step.
      store.mutate(() => undefined, { history: true, save: false });
      // classList throws on an empty token, and a CSS module lookup is typed
      // as possibly undefined, so the class is checked rather than spread.
      const grabbing = styles.grabbing;
      if (grabbing !== undefined) stageElement.classList.add(grabbing);
      try {
        stageElement.setPointerCapture(event.pointerId);
      } catch {
        /* Window tracking is the fallback, exactly as at app.js:4098. */
      }
      const start = {
        clientX: event.clientX,
        clientY: event.clientY,
        imageX: target.imageX || 0,
        imageY: target.imageY || 0,
      };
      const move = (moveEvent: PointerEvent) => {
        store.mutate(
          (document) => {
            const live = document.slides.find((item) => item.id === target.id);
            if (live === undefined) return;
            live.imageX = start.imageX + (moveEvent.clientX - start.clientX) / rect.width;
            live.imageY =
              start.imageY + (moveEvent.clientY - start.clientY) / rect.height;
            const held = constrainImagePosition(live, rect.width, rect.height);
            live.imageX = held.imageX;
            live.imageY = held.imageY;
          },
          { history: false },
        );
      };
      const end = () => {
        if (grabbing !== undefined) stageElement.classList.remove(grabbing);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [stageRef, store],
  );

  /* beginMarqueeSelection, app.js:2526-2583. */
  const beginMarquee = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (photoAdjust) return;
      if (isInteractiveTarget(event.target)) return;
      const surface = innerRef.current;
      const marquee = marqueeRef.current;
      if (surface === null || marquee === null) return;
      // app.js:2299-2306. The first click always commits the crop and does
      // nothing else, so the selection survives it.
      if (store.getSnapshot().croppingOverlayId !== null) {
        event.preventDefault();
        onFinishCrop?.();
        return;
      }
      event.preventDefault();

      const additive = event.metaKey || event.ctrlKey;
      const baseKeys: LayerKey[] = additive ? [...store.getSnapshot().selection] : [];
      const basePrimary = additive ? (baseKeys.at(-1) ?? null) : null;
      // The selection drops on pointer down, not on release, so a plain click on
      // empty canvas deselects at once (app.js:2534). app.js:2578 then restored
      // the same keys on a drag that never moved, which could only ever set what
      // this line already set; that second call is not ported.
      store.select(baseKeys, basePrimary);

      const visible = styles.visible;
      const surfaceRect = surface.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      let moved = false;
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        /* Window tracking is the fallback, exactly as at app.js:2544. */
      }

      const move = (moveEvent: PointerEvent) => {
        const left = Math.min(start.x, moveEvent.clientX);
        const top = Math.min(start.y, moveEvent.clientY);
        const right = Math.max(start.x, moveEvent.clientX);
        const bottom = Math.max(start.y, moveEvent.clientY);
        moved ||=
          Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >
          MARQUEE_THRESHOLD;
        if (visible !== undefined) marquee.classList.toggle(visible, moved);
        marquee.style.left = `${String(left - surfaceRect.left)}px`;
        marquee.style.top = `${String(top - surfaceRect.top)}px`;
        marquee.style.width = `${String(right - left)}px`;
        marquee.style.height = `${String(bottom - top)}px`;
        if (!moved) return;

        const boxes = surface.querySelectorAll<HTMLElement>(
          "[data-layer-kind][data-layer-id]",
        );
        const hitKeys: LayerKey[] = [];
        for (const box of boxes) {
          const rect = box.getBoundingClientRect();
          const intersects =
            rect.right >= left &&
            rect.left <= right &&
            rect.bottom >= top &&
            rect.top <= bottom;
          if (!intersects) continue;
          const kind = box.dataset["layerKind"];
          const id = box.dataset["layerId"];
          if ((kind !== "overlay" && kind !== "text") || id === undefined) continue;
          hitKeys.push(layerKey(kind satisfies LayerKind, id));
        }
        const keys = [...new Set([...baseKeys, ...hitKeys])];
        store.select(keys, hitKeys.at(-1) ?? basePrimary);
      };
      const end = () => {
        if (visible !== undefined) marquee.classList.remove(visible);
        marquee.removeAttribute("style");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [innerRef, onFinishCrop, photoAdjust, store],
  );

  const layout =
    slide === null || !width || !height ? null : getImageLayout(slide, width, height);
  const imageStyle =
    layout === null
      ? undefined
      : {
          width: `${String(layout.width)}px`,
          height: `${String(layout.height)}px`,
          left: `${String(layout.left)}px`,
          top: `${String(layout.top)}px`,
        };

  const frameClass = [styles.frame, photoAdjust ? styles.adjusting : ""]
    .filter(Boolean)
    .join(" ");
  const stageClass = [styles.stage, photoAdjust ? styles.grabbable : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={styles.workspace}
      data-testid="workspace"
      aria-label="Image editor"
      ref={workspaceRef}
    >
      <div
        className={styles.inner}
        data-testid="workspace-surface"
        ref={innerRef}
        onPointerDown={beginMarquee}
      >
        <div className={styles.composition} ref={compositionRef}>
          <div className={styles.stageWrap}>
            {slide === null ? (
              <div className={styles.empty}>
                <h2>Add your first photos</h2>
                <p>
                  Choose one or several images from your computer. Each one becomes a
                  slide.
                </p>
              </div>
            ) : (
              <>
                <div className={frameClass}>
                  {background === null ? null : (
                    <img
                      className={styles.ghost}
                      src={background.url}
                      alt=""
                      draggable={false}
                      aria-hidden="true"
                      style={imageStyle}
                    />
                  )}
                  <div
                    className={stageClass}
                    data-testid="stage"
                    ref={stageRef}
                    /*
                     * app.js:2612-2613 also published --stage-scale and
                     * --chrome-height here, for the preview chrome and the text
                     * layers to read. Neither can, in this tree: app.js put the
                     * chrome inside the stage element, while the chrome and the
                     * layer stack are both siblings of it now, and a custom
                     * property does not reach a sibling. Both measure their own
                     * width instead (chrome/PreviewChrome.tsx and
                     * layers/LayerStack.tsx), which is the same number and
                     * cannot go stale. Publishing them unread on an element
                     * nobody inherits from only invites the next reader to
                     * build on a mechanism that is not there.
                     */
                    style={{
                      width: `${String(width)}px`,
                      height: `${String(height)}px`,
                    }}
                    onPointerDown={photoAdjust ? beginImageDrag : undefined}
                  >
                    {background === null ? null : (
                      <img
                        className={styles.image}
                        src={background.url}
                        alt={slide.name}
                        draggable={false}
                        style={imageStyle}
                      />
                    )}
                  </div>
                  <div className={styles.layerStack}>{children}</div>
                </div>
                <span className={styles.dimensions}>
                  {ratioControl}
                  <span className={styles.zoomControls} aria-label="Canvas zoom">
                    <button
                      className={styles.zoomButton}
                      type="button"
                      aria-label="Zoom canvas out"
                      onClick={() => {
                        setZoom((current) => current / ZOOM_BUTTON_STEP);
                      }}
                    >
                      −
                    </button>
                    <button
                      className={styles.zoomLevel}
                      type="button"
                      aria-label="Reset canvas zoom"
                      onClick={() => {
                        setZoom(1);
                      }}
                    >
                      {`${String(Math.round(zoom * 100))}%`}
                    </button>
                    <button
                      className={styles.zoomButton}
                      type="button"
                      aria-label="Zoom canvas in"
                      onClick={() => {
                        setZoom((current) => current * ZOOM_BUTTON_STEP);
                      }}
                    >
                      +
                    </button>
                  </span>
                </span>
              </>
            )}
          </div>
          {actions === undefined ? null : (
            <div
              className={styles.actions}
              ref={actionsRef}
              data-canvas-actions=""
              aria-label="Canvas actions"
            >
              {actions}
            </div>
          )}
        </div>
        <div className={styles.marquee} ref={marqueeRef} aria-hidden="true" />
      </div>
    </section>
  );
}
