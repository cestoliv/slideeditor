import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { StageRect } from "@shared/geometry/index.js";

/*
 * How large the slide canvas is, and where it sits on screen.
 *
 * app.js kept these in state.stageWidth and state.stageHeight, written by
 * sizeStage and read by every pointer conversion and by text measurement
 * (subtlety 12). A stale or zero value there silently computed drags and text
 * wrapping against DESIGN_WIDTH instead of the real stage. Here the numbers come
 * off the element the layers are drawn on, so there is no second copy to go
 * stale: the layer stack fills the stage exactly.
 */

export type StageBox = {
  /** Attach to the element that covers the stage. */
  ref: RefObject<HTMLDivElement | null>;
  /** The stage in CSS pixels, republished whenever it is resized. */
  size: { width: number; height: number };
  /**
   * The stage's live client rectangle, read at the moment a gesture needs it.
   *
   * A gesture reads this once at pointer down rather than through the rendered
   * size, because a workspace scroll during the drag moves left and top without
   * changing width or height.
   */
  rectOf: () => StageRect;
};

const EMPTY: StageRect = { left: 0, top: 0, width: 0, height: 0 };

export function useStageBox(): StageBox {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // A window resize listener would miss the case the editor actually hits: a
    // rail opening or the ratio changing resizes the stage without the window
    // changing at all (app.js:2308-2309 observes for the same reason).
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const rectOf = useCallback((): StageRect => {
    const element = ref.current;
    if (element === null) return EMPTY;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  return { ref, size, rectOf };
}
