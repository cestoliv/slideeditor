import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  applyCropValues,
  expandOverlayForCrop,
  getOverlayMetrics,
  localPointOnLayer,
  overlayCrop,
  restoreOverlayAfterCrop,
} from "@shared/geometry/index.js";
import type { AssetSize, Crop, CropChange, Point } from "@shared/geometry/index.js";
import type { Ratio } from "@shared/schema/index.js";
import { slideOf } from "./actions.js";
import { useLayerDrag } from "./useLayerDrag.js";
import type { GestureContext } from "./gestures.js";
import type { Handle } from "./LayerBox.js";

/*
 * The crop editor. Ported from beginCrop (app.js:1028-1044), exitCropMode
 * (app.js:1046-1061), finishCrop (app.js:1063-1068), beginCropMove
 * (app.js:3689-3717) and beginCropResize (app.js:3650-3688).
 *
 * Every number below comes from Task 4. applyCropValues, localPointOnLayer,
 * expandOverlayForCrop and restoreOverlayAfterCrop are pure coordinate maths
 * that Task 17's exporter needs as well, so there is exactly one copy of it.
 */

export type CropContext = GestureContext & {
  ratio: Ratio;
  /** Resolves the overlay's library asset, which the crop maths measures against. */
  assetOf: (itemId: string) => AssetSize | null;
};

export type CropController = {
  /** Opens the crop editor on one overlay, showing the whole asset in place. */
  begin: (overlayId: string) => void;
  /** Closes it, folding the crop back into the overlay's geometry. */
  finish: () => void;
  /** Closes it and throws the crop away, leaving the overlay expanded. */
  cancel: () => void;
  /** Drags the whole crop rectangle across the asset. */
  onRectPointerDown: (event: ReactPointerEvent) => void;
  /** Drags one of the crop rectangle's eight handles. */
  onHandlePointerDown: (handle: Handle, event: ReactPointerEvent) => void;
};

type CropStart = { crop: Crop; point: Point; handle: Handle | null };

export function useCrop(context: CropContext): CropController {
  const { store, ratio, assetOf, rectOf } = context;
  const start = useRef<CropStart | null>(null);

  /** The overlay being cropped, its asset, and its expanded box on the canvas. */
  const readCropping = useCallback(() => {
    const state = store.getSnapshot();
    const overlayId = state.croppingOverlayId;
    if (overlayId === null) return null;
    const slide =
      state.project.slides.find((item) => item.id === state.activeSlideId) ?? null;
    const overlay = slide?.overlays.find((item) => item.id === overlayId) ?? null;
    if (overlay === null) return null;
    const asset = assetOf(overlay.itemId);
    if (asset === null) return null;
    const metrics = getOverlayMetrics(overlay, asset, { ratio, cropping: true });
    return {
      overlay,
      asset,
      box: {
        x: overlay.x,
        y: overlay.y,
        width: metrics.width,
        height: metrics.height,
      },
    };
  }, [assetOf, ratio, store]);

  const pointAt = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const cropping = readCropping();
      const stageRect = rectOf();
      if (cropping === null || !stageRect.width || !stageRect.height) return null;
      return localPointOnLayer(
        clientX,
        clientY,
        stageRect,
        cropping.box,
        cropping.overlay.rotation,
      );
    },
    [readCropping, rectOf],
  );

  const writeCrop = useCallback(
    (next: CropChange) => {
      const state = store.getSnapshot();
      const overlayId = state.croppingOverlayId;
      const activeSlideId = state.activeSlideId;
      if (overlayId === null) return;
      const applied = applyCropValues(next);
      store.mutate(
        (document) => {
          const overlay = slideOf(document, activeSlideId)?.overlays.find(
            (item) => item.id === overlayId,
          );
          if (overlay === undefined) return;
          overlay.cropX = applied.x;
          overlay.cropY = applied.y;
          overlay.cropW = applied.w;
          overlay.cropH = applied.h;
        },
        { history: false },
      );
    },
    [store],
  );

  const begin = useCallback(
    (overlayId: string) => {
      const state = store.getSnapshot();
      const activeSlideId = state.activeSlideId;
      const overlay = state.project.slides
        .find((item) => item.id === activeSlideId)
        ?.overlays.find((item) => item.id === overlayId);
      if (overlay === undefined) return;
      const asset = assetOf(overlay.itemId);
      if (asset === null) return;
      store.selectOnly("overlay", overlayId);
      // app.js:1029 records before the overlay is widened, so one undo puts the
      // overlay back the size it was before the crop editor opened.
      store.mutate((document) => {
        const live = slideOf(document, activeSlideId)?.overlays.find(
          (item) => item.id === overlayId,
        );
        if (live === undefined) return;
        Object.assign(live, expandOverlayForCrop(live, asset, ratio));
      });
      store.setCropping(overlayId);
    },
    [assetOf, ratio, store],
  );

  const finish = useCallback(() => {
    const state = store.getSnapshot();
    const overlayId = state.croppingOverlayId;
    const activeSlideId = state.activeSlideId;
    if (overlayId === null) return;
    const overlay = state.project.slides
      .find((item) => item.id === activeSlideId)
      ?.overlays.find((item) => item.id === overlayId);
    const asset = overlay === undefined ? null : assetOf(overlay.itemId);
    store.setCropping(null);
    if (overlay === undefined) return;
    // app.js:1063-1067 records nothing here: the entry beginCrop opened, and
    // the one each crop drag opened, already cover the whole session.
    store.mutate(
      (document) => {
        const live = slideOf(document, activeSlideId)?.overlays.find(
          (item) => item.id === overlayId,
        );
        if (live === undefined) return;
        Object.assign(live, restoreOverlayAfterCrop(live, asset, ratio));
      },
      { history: false },
    );
  }, [assetOf, ratio, store]);

  /** app.js:3467. Leaving without applying, so the geometry is never written back. */
  const cancel = useCallback(() => {
    store.setCropping(null);
  }, [store]);

  /**
   * One move for both gestures. A null handle is the rectangle itself, which
   * travels whole; a handle moves its own edges and pins the opposite one.
   */
  const onCropMove = useCallback(
    (event: PointerEvent) => {
      const held = start.current;
      const point = pointAt(event.clientX, event.clientY);
      if (held === null || point === null) return;
      const shiftX = point.x - held.point.x;
      const shiftY = point.y - held.point.y;
      const handle = held.handle;
      if (handle === null) {
        writeCrop({
          x: held.crop.x + shiftX,
          y: held.crop.y + shiftY,
          w: held.crop.w,
          h: held.crop.h,
        });
        return;
      }
      const next: CropChange = { ...held.crop };
      if (handle.includes("e")) next.w = held.crop.w + shiftX;
      if (handle.includes("s")) next.h = held.crop.h + shiftY;
      if (handle.includes("w")) {
        next.x = held.crop.x + shiftX;
        next.w = held.crop.w - shiftX;
        // The west handle drags the origin, so the floor has to hold the east
        // edge still rather than the origin (app.js:3627).
        next.anchorX = held.crop.x + held.crop.w;
      }
      if (handle.includes("n")) {
        next.y = held.crop.y + shiftY;
        next.h = held.crop.h - shiftY;
        next.anchorY = held.crop.y + held.crop.h;
      }
      writeCrop(next);
    },
    [pointAt, writeCrop],
  );

  const endCropGesture = useCallback(() => {
    start.current = null;
  }, []);

  // app.js:3689 records nothing for a crop move, where app.js:3655 opens an
  // entry for a handle drag. The two gestures differ in that alone.
  const beginRectDrag = useLayerDrag({
    store,
    record: false,
    onMove: (_delta, event) => {
      onCropMove(event);
    },
    onEnd: endCropGesture,
  });

  const beginHandleDrag = useLayerDrag({
    store,
    onMove: (_delta, event) => {
      onCropMove(event);
    },
    onEnd: endCropGesture,
  });

  const openGesture = useCallback(
    (handle: Handle | null, event: ReactPointerEvent) => {
      const cropping = readCropping();
      const point = pointAt(event.clientX, event.clientY);
      if (cropping === null || point === null) return false;
      start.current = { crop: overlayCrop(cropping.overlay), point, handle };
      return true;
    },
    [pointAt, readCropping],
  );

  const onRectPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      if (!openGesture(null, event)) return;
      beginRectDrag(event);
    },
    [beginRectDrag, openGesture],
  );

  const onHandlePointerDown = useCallback(
    (handle: Handle, event: ReactPointerEvent) => {
      event.stopPropagation();
      if (!openGesture(handle, event)) return;
      beginHandleDrag(event);
    },
    [beginHandleDrag, openGesture],
  );

  return { begin, finish, cancel, onRectPointerDown, onHandlePointerDown };
}
