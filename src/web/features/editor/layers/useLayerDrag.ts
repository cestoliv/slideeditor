import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { EditorStore } from "../store.js";

/*
 * One pointer gesture on a layer, from press to release.
 *
 * app.js binds every gesture's pointermove, pointerup and pointercancel to
 * window (app.js:3656, app.js:3969-4017, app.js:4062-4091), which is why those
 * functions are so tangled: each one owns three global listeners and has to
 * remember to take all three back. This captures the pointer on the layer
 * element instead, so the browser retargets the rest of the gesture there and a
 * fast drag that leaves the stage keeps tracking on its own.
 *
 * Capture can be refused, and it is refused for a synthetic PointerEvent that
 * matches no live pointer, so window stays as the fallback exactly as it was.
 */

export type DragDelta = {
  /** Pointer travel since the press, in client pixels. */
  dx: number;
  /** The caller divides by the stage size, because this hook holds no geometry. */
  dy: number;
};

export type LayerDragOptions = {
  store: EditorStore;
  onMove: (delta: DragDelta, event: PointerEvent) => void;
  onEnd?: ((event: PointerEvent) => void) | undefined;
  /**
   * Runs before the first move, once the undo entry is open.
   *
   * A gesture that needs the element it was pressed on (to mark it, or to read
   * its box) reads it here rather than closing over a stale one.
   */
  onStart?: ((element: HTMLElement, event: PointerEvent) => void) | undefined;
  /**
   * Opens one undo entry at pointer down, the way app.js:3977 does, so the
   * whole gesture undoes in one step. beginCropMove (app.js:3689) is the one
   * gesture that records nothing, so it passes false.
   */
  record?: boolean | undefined;
};

/**
 * Returns the pointer-down handler for one kind of gesture.
 *
 * The undo entry is opened here rather than by the caller's first mutation,
 * because a gesture that ends up moving nothing still has to leave the history
 * where a gesture that moved something would have left it.
 */
export function useLayerDrag(
  options: LayerDragOptions,
): (event: ReactPointerEvent) => void {
  const { store } = options;
  // The handler outlives the render that made it, so the callbacks are read
  // through a ref rather than captured. Without this a drag started on one
  // render would keep calling the previous render's onMove.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  return useCallback(
    (event: ReactPointerEvent) => {
      // app.js:3486 lets only the primary button start a gesture, so a right
      // click opens the menu and a middle click does nothing.
      if (event.button !== 0) return;
      const element = event.currentTarget;
      if (!(element instanceof HTMLElement)) return;
      event.preventDefault();

      const { pointerId } = event;
      const startX = event.clientX;
      const startY = event.clientY;
      if (latest.current.record !== false) {
        // One entry for the gesture. Every mutation the gesture makes then
        // passes history: false, so sixty frames leave one step to undo.
        store.mutate(() => undefined, { history: true, save: false });
      }

      let captured = false;
      try {
        element.setPointerCapture(pointerId);
        captured = true;
      } catch {
        /* Window tracking is the fallback, exactly as at app.js:3979. */
      }
      const target: HTMLElement | Window = captured ? element : window;

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latest.current.onMove(
          { dx: moveEvent.clientX - startX, dy: moveEvent.clientY - startY },
          moveEvent,
        );
      };
      const end = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        target.removeEventListener("pointermove", move as EventListener);
        target.removeEventListener("pointerup", end as EventListener);
        // Dropping this teardown leaks a listener per touch gesture, which is
        // the reason app.js:3660 binds all three.
        target.removeEventListener("pointercancel", end as EventListener);
        if (captured) {
          try {
            element.releasePointerCapture(pointerId);
          } catch {
            /* The pointer is already gone, which is the outcome wanted anyway. */
          }
        }
        latest.current.onEnd?.(endEvent);
      };

      target.addEventListener("pointermove", move as EventListener);
      target.addEventListener("pointerup", end as EventListener);
      target.addEventListener("pointercancel", end as EventListener);
      latest.current.onStart?.(element, event.nativeEvent);
    },
    [store],
  );
}
