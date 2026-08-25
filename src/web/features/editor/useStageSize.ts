import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clamp,
  outputAspect,
} from "@shared/geometry/index.js";
import type { Ratio } from "@shared/schema/index.js";

/*
 * How large the slide canvas is on screen, and at what viewport zoom. Ported
 * from sizeStage (app.js:2584-2618) and setCanvasZoom (app.js:2619-2643).
 *
 * The old pair wrote state.stageWidth and state.stageHeight as module globals
 * and every pointer conversion read them; a stale value silently computed drags
 * against DESIGN_WIDTH instead of the real stage. Here the numbers are the
 * hook's return value, so nothing can read a size that no longer exists.
 *
 * The measuring lives in a class rather than in effects and callbacks, which is
 * how LibraryCache and ProjectsStore already read the world outside React. It
 * also keeps the hook clear of the two things measuring in an effect always
 * costs: a setState in an effect body, and a memoized callback whose real
 * dependency is a ref nobody can list.
 */

/** app.js:2624. Below this a zoom change is not worth a relayout. */
const ZOOM_EPSILON = 0.0001;

/** The point a zoom pivots around, in client coordinates. */
export type StageFocalPoint = { clientX: number; clientY: number };

/** The elements sizeStage measured, which the stage attaches to its own DOM. */
export type StageElements = {
  /** The scroll container. Its client box is the space the stage may use. */
  workspace: RefObject<HTMLElement | null>;
  /** The padded surface inside it. Its padding is the gutter (app.js:2589-2591). */
  inner: RefObject<HTMLDivElement | null>;
  /** The row holding the stage beside the actions. Its column gap counts (app.js:2596). */
  composition: RefObject<HTMLDivElement | null>;
  /** The actions column, whose width the stage may not take (app.js:2595). */
  actions: RefObject<HTMLDivElement | null>;
  /** The stage. Anchoring a zoom needs its rectangle before and after. */
  stage: RefObject<HTMLDivElement | null>;
};

export type StageSize = {
  width: number;
  height: number;
  zoom: number;
  /**
   * Zooms the viewport, clamping to the band and keeping the pixel under the
   * focal point where it was. Without a focal point the stage's own centre
   * holds still, which is what the zoom buttons want (app.js:2627-2628).
   *
   * Takes an updater as well as a number, because a wheel burst dispatches many
   * events before React hands back a new zoom and every one of them has to
   * compound on the last. app.js read the live state.canvasZoom for that reason.
   */
  setZoom: (
    nextZoom: number | ((current: number) => number),
    focal?: StageFocalPoint,
  ) => void;
  /** Attach these to the stage's own elements. */
  elements: StageElements;
};

type Snapshot = { width: number; height: number; zoom: number };

function paddingOf(element: HTMLElement | null): {
  horizontal: number;
  vertical: number;
} {
  if (element === null) return { horizontal: 0, vertical: 0 };
  const style = getComputedStyle(element);
  return {
    horizontal:
      (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
    vertical:
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0),
  };
}

class StageMetrics implements StageElements {
  readonly workspace: RefObject<HTMLElement | null> = { current: null };
  readonly inner: RefObject<HTMLDivElement | null> = { current: null };
  readonly composition: RefObject<HTMLDivElement | null> = { current: null };
  readonly actions: RefObject<HTMLDivElement | null> = { current: null };
  readonly stage: RefObject<HTMLDivElement | null> = { current: null };

  private snapshot: Snapshot = { width: 1, height: 1, zoom: 1 };
  private zoom = 1;
  private readonly listeners = new Set<() => void>();
  private observer: ResizeObserver | null = null;
  private observedActions: HTMLElement | null = null;
  // Set by setZoom and spent by settle, which runs at the first moment the
  // relaid-out stage exists to scroll against.
  private anchor: { focal: StageFocalPoint | null; rect: DOMRect } | null = null;

  /*
   * A window resize listener would miss the case the editor actually hits: a
   * rail opening or an inspector widening changes the workspace without the
   * window changing at all. app.js:2308-2309 observes for the same reason.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.observer === null) {
      this.observer = new ResizeObserver(() => {
        this.remeasure();
      });
      const surface = this.workspace.current;
      if (surface !== null) this.observer.observe(surface);
      /*
       * The row as well as the workspace. Nothing about the workspace changes
       * when a later task fills the actions slot, so without this the column
       * could appear and the stage would keep the width it had before it. The
       * row's own width feeds nothing that measure() reads, so watching it
       * cannot drive itself.
       */
      const composition = this.composition.current;
      if (composition !== null) this.observer.observe(composition);
      this.observeActions();
      this.remeasure();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.observer?.disconnect();
      this.observer = null;
      this.observedActions = null;
    };
  };

  /*
   * A pure read. Measuring here instead would touch the DOM on every render of
   * the stage, and the stage renders on every pointermove of a photo drag, so
   * a gesture would force one layout per frame for numbers that had not moved.
   * The observer is the only thing that can change these, so it is the only
   * thing that measures.
   */
  getSnapshot = (): Snapshot => this.snapshot;

  setZoom = (
    nextZoom: number | ((current: number) => number),
    focal?: StageFocalPoint,
  ): void => {
    const wanted = typeof nextZoom === "function" ? nextZoom(this.zoom) : nextZoom;
    const clamped = clamp(wanted, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
    if (Math.abs(clamped - this.zoom) < ZOOM_EPSILON) return;
    const stage = this.stage.current;
    if (stage !== null) {
      this.anchor = { focal: focal ?? null, rect: stage.getBoundingClientRect() };
    }
    this.zoom = clamped;
    this.snapshot = { ...this.snapshot, zoom: clamped };
    this.publish();
  };

  /** Reads the DOM once and tells React only when a number actually moved. */
  private remeasure(): void {
    this.observeActions();
    const measured = this.measure();
    const held = this.snapshot;
    if (held.width === measured.width && held.height === measured.height) return;
    this.snapshot = { ...measured, zoom: this.zoom };
    this.publish();
  }

  /** app.js:2636-2641. Scrolls so the anchored point sits where it did. */
  settle = (): void => {
    const anchor = this.anchor;
    this.anchor = null;
    if (anchor === null) return;
    const surface = this.workspace.current;
    const stage = this.stage.current;
    if (surface === null || stage === null) return;
    const before = anchor.rect;
    const focalX =
      anchor.focal !== null && Number.isFinite(anchor.focal.clientX)
        ? clamp(anchor.focal.clientX, before.left, before.right)
        : before.left + before.width / 2;
    const focalY =
      anchor.focal !== null && Number.isFinite(anchor.focal.clientY)
        ? clamp(anchor.focal.clientY, before.top, before.bottom)
        : before.top + before.height / 2;
    const relativeX = before.width ? (focalX - before.left) / before.width : 0.5;
    const relativeY = before.height ? (focalY - before.top) / before.height : 0.5;
    const after = stage.getBoundingClientRect();
    surface.scrollLeft += after.left + relativeX * after.width - focalX;
    surface.scrollTop += after.top + relativeY * after.height - focalY;
  };

  /** app.js:2588-2600, which is every subtraction between the window and the stage. */
  private measure(): { width: number; height: number } {
    const surface = this.workspace.current;
    if (surface === null) return { width: 1, height: 1 };
    const gutter = paddingOf(this.inner.current);
    const availableWidth = Math.max(1, surface.clientWidth - gutter.horizontal);
    const availableHeight = Math.max(1, surface.clientHeight - gutter.vertical);
    const column = this.actions.current;
    const actions = column?.offsetWidth ?? 0;
    const composition = this.composition.current;
    // The gap goes with the column. getComputedStyle reports the declared gap
    // whether or not there is a second child to sit beside, so reading it
    // unconditionally would steal a gap's worth of stage for empty space
    // whenever no task has filled the actions slot yet.
    const gap =
      column === null || composition === null
        ? 0
        : parseFloat(getComputedStyle(composition).columnGap) || 0;
    return {
      width: Math.max(1, availableWidth - actions - gap),
      height: availableHeight,
    };
  }

  /* The actions column can arrive after the first subscribe, when a later task
     fills the slot, so observation is checked rather than assumed. */
  private observeActions(): void {
    const element = this.actions.current;
    if (this.observer === null || element === null) return;
    if (this.observedActions === element) return;
    this.observer.observe(element);
    this.observedActions = element;
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function useStageSize(ratio: Ratio): StageSize {
  const [metrics] = useState(() => new StageMetrics());
  const snapshot = useSyncExternalStore(metrics.subscribe, metrics.getSnapshot);

  const aspect = outputAspect(ratio);
  let width = snapshot.width;
  let height = width / aspect;
  // app.js:2604-2607. Only height is refitted, so a zoomed stage is allowed to
  // overflow the workspace and scroll rather than shrinking back into it.
  if (height > snapshot.height) {
    height = snapshot.height;
    width = height * aspect;
  }
  width *= snapshot.zoom;
  height *= snapshot.zoom;

  useLayoutEffect(() => {
    metrics.settle();
  }, [metrics, width, height]);

  return {
    width,
    height,
    zoom: snapshot.zoom,
    setZoom: metrics.setZoom,
    elements: metrics,
  };
}
