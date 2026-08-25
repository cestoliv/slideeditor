import { useCallback } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  constrainOverlay,
  getOverlayMetrics,
  overlayCrop,
} from "@shared/geometry/index.js";
import type { LibraryItem, Overlay, Ratio } from "@shared/schema/index.js";
import type { EditorStore } from "../store.js";
import {
  OVERLAY_RESIZE_LIMITS,
  deleteSelectedLayers,
  prepareLayerPointerSelection,
  slideOf,
} from "./actions.js";
import { useMoveGesture, useResizeGesture, useRotateGesture } from "./gestures.js";
import type { GestureContext, LayerRect } from "./gestures.js";
import { ALL_HANDLES, LayerBox, isCornerHandle, layerClipCss } from "./LayerBox.js";
import type { Handle } from "./LayerBox.js";
import type { CropController } from "./useCrop.js";
import { deleteOnPointerOverTrash, highlightTrash } from "./trash.js";
import styles from "./OverlayLayer.module.css";

/*
 * One photo overlay on the canvas. Ported from renderOverlayBox
 * (app.js:1819-1863), updateOverlayBox (app.js:2894-2929) and bindOverlayBox
 * (app.js:3491-3523).
 *
 * The overlay is painted twice: once unclipped and greyed, once clipped to the
 * canvas. The greyed copy is what shows a selected overlay reaching off the
 * slide, so the part that will not export is visible while it is being placed
 * (styles.css:1609-1621).
 */

export type OverlayLayerProps = {
  store: EditorStore;
  overlay: Overlay;
  asset: LibraryItem | null;
  ratio: Ratio;
  selected: boolean;
  primary: boolean;
  /** app.js:1986. Handles show for a single selection only. */
  handles: boolean;
  cropping: boolean;
  context: GestureContext;
  crop: CropController;
  /** app.js:3510. A press on another layer commits the crop and does nothing else. */
  onFinishCrop: () => void;
};

export function OverlayLayer({
  store,
  overlay,
  asset,
  ratio,
  selected,
  primary,
  handles,
  cropping,
  context,
  crop,
  onFinishCrop,
}: OverlayLayerProps) {
  const overlayId = overlay.id;
  const metrics = getOverlayMetrics(overlay, asset, { ratio, cropping });
  const visibleCrop = overlayCrop(overlay);

  /** The box a gesture starts from, read live so a drag never uses a stale one. */
  const rectOfOverlay = useCallback((): LayerRect | null => {
    const state = store.getSnapshot();
    const live = state.project.slides
      .find((slide) => slide.id === state.activeSlideId)
      ?.overlays.find((item) => item.id === overlayId);
    if (live === undefined) return null;
    const box = getOverlayMetrics(live, asset, { ratio });
    return {
      x: live.x,
      y: live.y,
      width: box.width,
      height: box.height,
      rotation: live.rotation,
    };
  }, [asset, overlayId, ratio, store]);

  const writeOverlay = useCallback(
    (change: (live: Overlay) => void) => {
      const activeSlideId = store.getSnapshot().activeSlideId;
      store.mutate(
        (document) => {
          const live = slideOf(document, activeSlideId)?.overlays.find(
            (item) => item.id === overlayId,
          );
          if (live === undefined) return;
          change(live);
        },
        { history: false },
      );
    },
    [overlayId, store],
  );

  const beginMove = useMoveGesture(context, {
    kind: "overlay",
    onMoveOver: (event) => {
      highlightTrash(event);
    },
    onDrop: (event) => {
      deleteOnPointerOverTrash(store, event);
    },
  });

  const beginResize = useResizeGesture(context, {
    rect: rectOfOverlay,
    // app.js:3516-3517 fixes this at pointer down: a corner keeps the aspect
    // ratio and an edge never does. Alt to free a corner is new, and it is the
    // one interaction in this file the old app does not have.
    limits: (handle, event) => ({
      ...OVERLAY_RESIZE_LIMITS,
      preserveAspect: isCornerHandle(handle) && !event.altKey,
    }),
    apply: (next) => {
      writeOverlay((live) => {
        live.x = next.x;
        live.y = next.y;
        live.width = next.width;
        live.height = next.height;
        Object.assign(live, constrainOverlay(live, asset, ratio));
      });
    },
  });

  const beginRotate = useRotateGesture(context, {
    rect: rectOfOverlay,
    apply: (rotation) => {
      writeOverlay((live) => {
        live.rotation = rotation;
      });
    },
  });

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!prepareLayerPointerSelection(store, event, "overlay", overlayId)) return;
      const croppingId = store.getSnapshot().croppingOverlayId;
      if (croppingId !== null && croppingId !== overlayId) {
        onFinishCrop();
        return;
      }
      // While this overlay is the one being cropped its body drags nothing: the
      // crop rectangle and its handles own every press inside it.
      if (croppingId === overlayId) return;
      beginMove(event);
    },
    [beginMove, onFinishCrop, overlayId, store],
  );

  const onHandlePointerDown = useCallback(
    (handle: Handle, event: ReactPointerEvent<HTMLElement>) => {
      event.stopPropagation();
      beginResize(handle, event);
    },
    [beginResize],
  );

  if (asset === null) return null;

  const imageStyle: CSSProperties = cropping
    ? { width: "100%", height: "100%", left: 0, top: 0 }
    : {
        width: `${String(100 / visibleCrop.w)}%`,
        height: `${String(100 / visibleCrop.h)}%`,
        left: `${String((-visibleCrop.x / visibleCrop.w) * 100)}%`,
        top: `${String((-visibleCrop.y / visibleCrop.h) * 100)}%`,
      };

  return (
    <LayerBox
      kind="overlay"
      id={overlayId}
      x={overlay.x}
      y={overlay.y}
      width={metrics.width}
      height={metrics.height}
      rotation={overlay.rotation}
      selected={selected}
      primary={primary}
      handles={handles && !cropping}
      className={cropping ? styles.cropping : undefined}
      aria-label={`Photo overlay: ${asset.name}`}
      onPointerDown={onPointerDown}
      onActivate={() => {
        store.selectOnly("overlay", overlayId);
      }}
      onKeyDown={(event) => {
        // app.js:3518-3522 bound Delete on the box itself. An overlay had none
        // at all here, so the key only worked through the document handler.
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        event.preventDefault();
        deleteSelectedLayers(store);
      }}
      onHandlePointerDown={onHandlePointerDown}
      onRotatePointerDown={(event) => {
        event.stopPropagation();
        beginRotate(event);
      }}
    >
      <div
        className={`${styles.clip ?? ""} ${styles.outside ?? ""}`}
        data-visible={selected || cropping ? "true" : undefined}
        aria-hidden="true"
      >
        <img src={asset.url} alt="" draggable={false} style={imageStyle} />
      </div>
      <div
        className={`${styles.clip ?? ""} ${styles.inside ?? ""}`}
        data-testid="overlay-inside"
        style={{
          clipPath: layerClipCss(overlay.x, overlay.y, metrics.width, metrics.height),
        }}
      >
        <img src={asset.url} alt="" draggable={false} style={imageStyle} />
      </div>
      {cropping ? (
        <div
          className={styles.cropRect}
          data-testid="crop-rect"
          style={{
            left: `${String(visibleCrop.x * 100)}%`,
            top: `${String(visibleCrop.y * 100)}%`,
            width: `${String(visibleCrop.w * 100)}%`,
            height: `${String(visibleCrop.h * 100)}%`,
          }}
          onPointerDown={crop.onRectPointerDown}
        >
          {ALL_HANDLES.map((handle) => (
            <span
              key={handle}
              className={isCornerHandle(handle) ? styles.cropCorner : styles.cropEdge}
              data-crop-handle={handle}
              aria-hidden="true"
              onPointerDown={(event) => {
                crop.onHandlePointerDown(handle, event);
              }}
            />
          ))}
        </div>
      ) : null}
    </LayerBox>
  );
}
