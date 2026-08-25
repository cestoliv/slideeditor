import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { pointerDeltaInLayerAxes, resizeLayerRect } from "@shared/geometry/index.js";
import type { Rect, ResizeLimits, StageRect } from "@shared/geometry/index.js";
import type { EditorStore } from "../store.js";
import { parseLayerKey, selectedLayers } from "../selection.js";
import type { LayerKey, LayerKind } from "../selection.js";
import { useLayerDrag } from "./useLayerDrag.js";
import type { Handle } from "./LayerBox.js";

/*
 * The three gestures both layer kinds share: move, resize from one of eight
 * handles, and rotate. Ported from beginLayerDrag (app.js:3973-4017),
 * beginOverlayResize and beginResize (app.js:3729-3775, app.js:4019-4060), and
 * beginOverlayRotate and beginTextRotate (app.js:3776-3814, app.js:4062-4091).
 *
 * Not one line of coordinate maths lives here. pointerDeltaInLayerAxes and
 * resizeLayerRect are Task 4's, and importing them is what keeps the editor and
 * the exporter measuring the same slide.
 */

/** app.js:3540. Rotation is degrees clockwise, about the layer's own centre. */
export type LayerRect = Rect & { rotation: number };

export type GestureContext = {
  store: EditorStore;
  /** The stage in CSS pixels. Every pixel delta is divided by this. */
  stage: { width: number; height: number };
  /** The stage's live client rectangle, for the gestures that need an origin. */
  rectOf: () => StageRect;
};

/** app.js:4084. Shift snaps a rotation to the nearest fifteen degrees. */
const ROTATION_SNAP = 15;

/** app.js:3785. A rotation is stored in 0..360, whichever way the pointer went. */
function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export type MoveOptions = {
  /** Which kind was grabbed. Only an overlay drag offers the trash (app.js:4007). */
  kind: LayerKind;
  /** Runs on every move, so an overlay drag can light the trash up. */
  onMoveOver?: ((event: PointerEvent) => void) | undefined;
  /** Runs once on release, with the event that ended the drag. */
  onDrop?: ((event: PointerEvent) => void) | undefined;
};

type MovingLayer = { key: LayerKey; x: number; y: number };

/**
 * Moves every selected layer by one pointer delta (app.js:4003-4009).
 *
 * The whole selection travels together, and the delta is divided by the stage
 * rather than rotated, because a plain move is in stage axes for every layer
 * however each one is turned.
 */
export function useMoveGesture(
  { store, stage }: GestureContext,
  { kind, onMoveOver, onDrop }: MoveOptions,
): (event: ReactPointerEvent) => void {
  const moving = useRef<MovingLayer[]>([]);

  return useLayerDrag({
    store,
    onStart: () => {
      const state = store.getSnapshot();
      const slide =
        state.project.slides.find((item) => item.id === state.activeSlideId) ?? null;
      moving.current = selectedLayers(slide, state.selection).map((entry) => ({
        key: entry.key,
        x: entry.item.x,
        y: entry.item.y,
      }));
    },
    onMove: ({ dx, dy }, event) => {
      const offsetX = dx / (stage.width || 1);
      const offsetY = dy / (stage.height || 1);
      const activeSlideId = store.getSnapshot().activeSlideId;
      store.mutate(
        (document) => {
          const slide = document.slides.find((item) => item.id === activeSlideId);
          if (slide === undefined) return;
          for (const entry of moving.current) {
            const parsed = parseLayerKey(entry.key);
            if (parsed === null) continue;
            const layer =
              parsed.kind === "text"
                ? slide.texts.find((item) => item.id === parsed.id)
                : slide.overlays.find((item) => item.id === parsed.id);
            if (layer === undefined) continue;
            layer.x = entry.x + offsetX;
            layer.y = entry.y + offsetY;
          }
        },
        { history: false },
      );
      if (kind === "overlay") onMoveOver?.(event);
    },
    onEnd: (event) => {
      moving.current = [];
      if (kind === "overlay") onDrop?.(event);
    },
  });
}

export type ResizeOptions = {
  /** The box at pointer down, read once so the drag is measured from one origin. */
  rect: () => LayerRect | null;
  /**
   * The limits for one handle, read on every move rather than at pointer down,
   * so a modifier pressed part way through a drag takes effect at once.
   */
  limits: (handle: Handle, event: PointerEvent) => ResizeLimits;
  /** Writes the new box, applying whatever constraint the layer kind needs. */
  apply: (next: Rect) => void;
};

/**
 * Resizes from one handle, keeping the opposite edge or corner still.
 *
 * The pointer delta is turned into the layer's own axes first (app.js:3540-3546)
 * because x and width are fractions of the canvas width while y and height are
 * fractions of its height, so rotating the normalized numbers directly shears
 * every rotated layer.
 */
export function useResizeGesture(
  { store, stage }: GestureContext,
  { rect, limits, apply }: ResizeOptions,
): (handle: Handle, event: ReactPointerEvent) => void {
  const active = useRef<{ handle: Handle; rect: LayerRect } | null>(null);

  const begin = useLayerDrag({
    store,
    onMove: ({ dx, dy }, event) => {
      const start = active.current;
      if (start === null) return;
      const delta = pointerDeltaInLayerAxes(dx, dy, start.rect.rotation, stage);
      apply(
        resizeLayerRect(
          start.rect,
          start.handle,
          delta,
          limits(start.handle, event),
          stage,
        ),
      );
    },
    onEnd: () => {
      active.current = null;
    },
  });

  return useCallback(
    (handle: Handle, event: ReactPointerEvent) => {
      const start = rect();
      if (start === null) return;
      active.current = { handle, rect: start };
      begin(event);
    },
    [begin, rect],
  );
}

export type RotateOptions = {
  rect: () => LayerRect | null;
  apply: (rotation: number) => void;
};

/**
 * Turns the layer about its own centre, following the angle from that centre to
 * the pointer (app.js:3782-3789). Shift snaps to fifteen degrees, so a straight
 * edge is reachable without a steady hand.
 */
export function useRotateGesture(
  { store, rectOf }: GestureContext,
  { rect, apply }: RotateOptions,
): (event: ReactPointerEvent) => void {
  const active = useRef<{
    centerX: number;
    centerY: number;
    angle: number;
    rotation: number;
  } | null>(null);

  const begin = useLayerDrag({
    store,
    onMove: (_delta, event) => {
      const start = active.current;
      if (start === null) return;
      const angle = Math.atan2(
        event.clientY - start.centerY,
        event.clientX - start.centerX,
      );
      let degrees = start.rotation + ((angle - start.angle) * 180) / Math.PI;
      if (event.shiftKey) degrees = Math.round(degrees / ROTATION_SNAP) * ROTATION_SNAP;
      apply(normalizeRotation(degrees));
    },
    onEnd: () => {
      active.current = null;
    },
  });

  return useCallback(
    (event: ReactPointerEvent) => {
      const start = rect();
      const stageRect = rectOf();
      if (start === null || !stageRect.width || !stageRect.height) return;
      const centerX = stageRect.left + (start.x + start.width / 2) * stageRect.width;
      const centerY = stageRect.top + (start.y + start.height / 2) * stageRect.height;
      active.current = {
        centerX,
        centerY,
        angle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
        rotation: start.rotation,
      };
      begin(event);
    },
    [begin, rect, rectOf],
  );
}
