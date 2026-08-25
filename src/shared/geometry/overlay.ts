import type { Ratio } from "../schema/index.js";
import type { StageRect } from "./image.js";
import { clamp } from "./math.js";
import { OUTPUT_WIDTH, outputAspect, outputHeight } from "./ratio.js";

/** The largest share of the canvas a freshly placed overlay may take (app.js:27). */
export const INITIAL_OVERLAY_MAX_SIZE = 0.82;

/**
 * The smallest a crop may get along either axis (app.js:3621, and the same
 * floor written out at app.js:491-494). A crop that reached zero would divide
 * by nothing in getOverlayMetrics.
 */
export const MIN_CROP_SIZE = 0.05;

/** A library image, measured in its own pixels. */
export interface AssetSize {
  width: number;
  height: number;
}

/** The stage, measured in screen pixels. */
export interface StageSize {
  width: number;
  height: number;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A crop rectangle a drag proposes, before it is made legal. anchorX and
 * anchorY carry the edge the drag is measured from, and only a west or north
 * handle sets them (app.js:3627, app.js:3631).
 */
export interface CropChange extends Crop {
  // An explicit undefined is allowed as well as an absent key, because
  // app.js:3627 tests `!= null` and a caller's own anchor may be undefined.
  anchorX?: number | null | undefined;
  anchorY?: number | null | undefined;
}

/** The crop fields of an overlay, each one optional on a legacy document. */
export interface CropSource {
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
}

/**
 * An overlay far enough along to be measured. height stays optional because a
 * saved overlay may genuinely have none, and getOverlayMetrics is the function
 * that owns computing it.
 */
export interface OverlayGeometry extends CropSource {
  width: number;
  // An explicit undefined is allowed as well as an absent key, so a caller
  // holding a `number | undefined` can build one under
  // exactOptionalPropertyTypes. Absent is the case this field exists for.
  height?: number | undefined;
}

export interface OverlayMetrics {
  width: number;
  height: number;
}

export interface OverlayMetricsOptions {
  /** The slideshow ratio, which sets how a width in canvas widths becomes a height. */
  ratio: Ratio;
  /** Measures the whole asset rather than the crop, for the crop editor's ghost. */
  full?: boolean;
  /** True while this overlay is the one being cropped, which also shows it whole. */
  cropping?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RotatedRect extends Rect {
  rotation?: number;
}

export interface Point {
  x: number;
  y: number;
}

export type ResizeHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export interface ResizeLimits {
  minWidth: number;
  minHeight: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Scales width and height together along the dragged diagonal. */
  preserveAspect?: boolean;
}

/**
 * The visible region of the asset, as fractions of it (app.js:490-496). The
 * floors keep a crop from collapsing to nothing, so an overlay always shows
 * some image.
 */
export function overlayCrop(overlay: CropSource): Crop {
  const x = clamp(Number(overlay.cropX) || 0, 0, 1 - MIN_CROP_SIZE);
  const y = clamp(Number(overlay.cropY) || 0, 0, 1 - MIN_CROP_SIZE);
  const w = clamp(Number(overlay.cropW) || 1, MIN_CROP_SIZE, 1 - x);
  const h = clamp(Number(overlay.cropH) || 1, MIN_CROP_SIZE, 1 - y);
  return { x, y, w, h };
}

/**
 * Turns a dragged crop rectangle into the four values an overlay stores
 * (app.js:3620-3648). A handle that crosses its opposite edge collapses to the
 * floor and pins itself to the anchor the drag started from, and a rectangle
 * that runs off the asset is trimmed rather than moved.
 *
 * app.js passes the overlay too and writes the four fields onto it. Only the
 * proposed rectangle takes part in the arithmetic, so this takes that alone and
 * returns the result.
 */
export function applyCropValues(next: CropChange): Crop {
  let x = next.x;
  let y = next.y;
  let w = next.w;
  let h = next.h;
  if (w < MIN_CROP_SIZE) {
    // The west handle drags the origin, so the floor has to hold the east edge
    // still rather than the origin.
    if (next.anchorX != null) x = next.anchorX - MIN_CROP_SIZE;
    w = MIN_CROP_SIZE;
  }
  if (h < MIN_CROP_SIZE) {
    if (next.anchorY != null) y = next.anchorY - MIN_CROP_SIZE;
    h = MIN_CROP_SIZE;
  }
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  const cropX = clamp(x, 0, 1 - MIN_CROP_SIZE);
  const cropY = clamp(y, 0, 1 - MIN_CROP_SIZE);
  return {
    x: cropX,
    y: cropY,
    w: clamp(w, MIN_CROP_SIZE, 1 - cropX),
    h: clamp(h, MIN_CROP_SIZE, 1 - cropY),
  };
}

/**
 * The height that keeps the cropped asset undistorted, in canvas heights
 * (app.js:501-505, app.js:543 and app.js:887 each compute it). A ratio
 * change makes every stored height stale, so applyProjectRatio recomputes each
 * one from here, which is what keeps a ratio change from stretching a photo.
 */
export function naturalOverlayHeight(
  width: number,
  asset: AssetSize | null | undefined,
  ratio: Ratio,
  crop: Pick<Crop, "w" | "h"> = { w: 1, h: 1 },
): number {
  const srcW = (asset?.width || 1) * crop.w;
  const srcH = (asset?.height || 1) * crop.h;
  const aspect = srcW ? srcH / srcW : 1;
  return width * outputAspect(ratio) * aspect;
}

/**
 * Measures an overlay in canvas fractions (app.js:498-507). width is a share of
 * the canvas width and height a share of its height, so the height has to pass
 * through the output aspect to keep the cropped image undistorted at any ratio.
 * A stored height wins, because the user may have resized the overlay away from
 * its natural shape.
 */
export function getOverlayMetrics(
  overlay: OverlayGeometry,
  asset: AssetSize | null | undefined,
  { ratio, full = false, cropping = false }: OverlayMetricsOptions,
): OverlayMetrics {
  const crop = full || cropping ? { w: 1, h: 1 } : overlayCrop(overlay);
  const width = overlay.width;
  const naturalHeight = naturalOverlayHeight(width, asset, ratio, crop);
  // app.js:506 runs Number(overlay.height) through Number.isFinite, and
  // Number(null) is 0, so a null height renders an invisible overlay there and
  // is recomputed here. overlaySchema rejects null outright, so no saved
  // document reaches either branch, and this is the better of the two.
  const stored = overlay.height;
  const height = stored !== undefined && Number.isFinite(stored) ? stored : naturalHeight;
  return { width, height };
}

/**
 * Pulls an overlay back into the shapes the editor can render (app.js:539-547).
 * Returns a new overlay rather than mutating the stored one, because this
 * module stays pure. A zero or missing height becomes the natural one, so an
 * overlay never collapses.
 */
export function constrainOverlay<T extends OverlayGeometry & { rotation?: number }>(
  overlay: T,
  asset: AssetSize | null | undefined,
  ratio: Ratio,
): T {
  if (!asset) return overlay;
  const width = clamp(overlay.width || 0.34, 0.04, 2.4);
  const naturalHeight = naturalOverlayHeight(width, asset, ratio, overlayCrop(overlay));
  const height = clamp(overlay.height || naturalHeight, 0.025, 2.4);
  const rotation = (((overlay.rotation || 0) % 360) + 360) % 360;
  return { ...overlay, width, height, rotation };
}

/**
 * Un-applies a stored crop so the crop editor can show the whole asset in
 * place (app.js:1035-1041). The overlay grows to the box the uncropped image
 * would occupy, and its origin moves so the visible part does not shift. An
 * identity crop is left alone, on the same near-enough test app.js:1036 uses.
 *
 * This reads the metrics off the overlay as it stands, where app.js:1037
 * assigns the widened width first and measures afterwards. That difference is
 * deliberate, and it is a bug fix rather than a port. On the path where the
 * overlay carries no stored height, app.js measures the natural height from the
 * already widened width and then divides by crop.h a second time, overstating
 * the height by a factor of 1 / crop.w. A half-width crop therefore doubles the
 * overlay's height the first time it is cropped: measured at 0.135 in, 0.270
 * out. app.js barely reaches that path, because normalizeProject fills every
 * height at load (app.js:119-123). overlaySchema leaves height optional, so the
 * rewrite reaches it, and restoring the original order would corrupt an
 * overlay's geometry on its first crop.
 */
export function expandOverlayForCrop<
  T extends OverlayGeometry & { x: number; y: number },
>(overlay: T, asset: AssetSize | null | undefined, ratio: Ratio): T {
  const crop = overlayCrop(overlay);
  if (crop.w >= 0.999 && crop.h >= 0.999 && crop.x <= 0.001 && crop.y <= 0.001) {
    return overlay;
  }
  const width = overlay.width / crop.w;
  const height = getOverlayMetrics(overlay, asset, { ratio }).height / crop.h;
  return {
    ...overlay,
    width,
    height,
    x: overlay.x - crop.x * width,
    y: overlay.y - crop.y * height,
  };
}

/**
 * Re-applies the crop when the crop editor closes (app.js:1053-1059), the exact
 * inverse of expandOverlayForCrop. Any asymmetry between the two would drift
 * the overlay a little on every crop, so the round trip is tested.
 */
export function restoreOverlayAfterCrop<
  T extends OverlayGeometry & { x: number; y: number; rotation?: number },
>(overlay: T, asset: AssetSize | null | undefined, ratio: Ratio): T {
  const crop = overlayCrop(overlay);
  const full = getOverlayMetrics(overlay, asset, { ratio, full: true });
  const next = {
    ...overlay,
    x: overlay.x + crop.x * full.width,
    y: overlay.y + crop.y * full.height,
    width: overlay.width * crop.w,
    height: full.height * crop.h,
  };
  return asset ? constrainOverlay(next, asset, ratio) : next;
}

/**
 * The width a newly placed overlay takes, in canvas widths (app.js:549-562).
 * The asset starts at its own pixel size and only shrinks, so a small image
 * never gets blown up and a large one never fills the slide.
 */
export function initialOverlayWidth(
  asset: AssetSize | null | undefined,
  ratio: Ratio,
): number {
  const sourceWidth = Number(asset?.width);
  const sourceHeight = Number(asset?.height);
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    return 0.34;
  }
  const naturalWidth = sourceWidth / OUTPUT_WIDTH;
  const naturalHeight = sourceHeight / outputHeight(ratio);
  const fitScale = Math.min(
    1,
    INITIAL_OVERLAY_MAX_SIZE / naturalWidth,
    INITIAL_OVERLAY_MAX_SIZE / naturalHeight,
  );
  return clamp(naturalWidth * fitScale, 0.04, INITIAL_OVERLAY_MAX_SIZE);
}

/** Turns a stage-axis delta into the layer's own rotated axes (app.js:3533-3538). */
export function rotateDelta(dx: number, dy: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/**
 * A pointer drag, in pixels, expressed in the layer's axes and in canvas
 * fractions (app.js:3540-3546). The caller passes the raw pixel delta, because
 * this module never sees an event.
 */
export function pointerDeltaInLayerAxes(
  dx: number,
  dy: number,
  degrees: number,
  stage: StageSize,
): Point {
  const rotated = rotateDelta(dx, dy, degrees);
  return { x: rotated.x / stage.width, y: rotated.y / stage.height };
}

/**
 * The inverse of pointerDeltaInLayerAxes (app.js:3548-3558). A layer-axis
 * offset in canvas fractions goes back to stage axes, through pixels, so the
 * canvas aspect does not shear the rotation.
 */
export function layerOffsetToStage(
  dx: number,
  dy: number,
  degrees: number,
  stage: StageSize,
): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const pixelX = dx * stage.width;
  const pixelY = dy * stage.height;
  return {
    x: (pixelX * cos - pixelY * sin) / stage.width,
    y: (pixelX * sin + pixelY * cos) / stage.height,
  };
}

/**
 * Resizes a layer from one handle, keeping the opposite edge or corner where it
 * is (app.js:3560-3604). The maths works from the centre, because a rotated
 * layer turns about its centre, so the shift is applied in stage axes.
 */
export function resizeLayerRect(
  start: RotatedRect,
  handle: ResizeHandle,
  delta: Point,
  limits: ResizeLimits,
  stage: StageSize,
): Rect {
  const {
    minWidth,
    minHeight,
    maxWidth = Infinity,
    maxHeight = Infinity,
    preserveAspect = false,
  } = limits;
  const rotation = start.rotation || 0;
  const centerX = start.x + start.width / 2;
  const centerY = start.y + start.height / 2;
  let width = start.width;
  let height = start.height;
  let centerShiftX = 0;
  let centerShiftY = 0;
  if (preserveAspect) {
    const signX = handle.includes("e") ? 1 : -1;
    const signY = handle.includes("s") ? 1 : -1;
    const vectorX = signX * start.width * stage.width;
    const vectorY = signY * start.height * stage.height;
    const nextX = vectorX + delta.x * stage.width;
    const nextY = vectorY + delta.y * stage.height;
    const projectedScale =
      (nextX * vectorX + nextY * vectorY) / (vectorX ** 2 + vectorY ** 2 || 1);
    const scale = clamp(
      projectedScale,
      Math.max(minWidth / start.width, minHeight / start.height),
      Math.min(maxWidth / start.width, maxHeight / start.height),
    );
    width = start.width * scale;
    height = start.height * scale;
    centerShiftX = (signX * (width - start.width)) / 2;
    centerShiftY = (signY * (height - start.height)) / 2;
  } else {
    if (handle.includes("e")) {
      width = clamp(start.width + delta.x, minWidth, maxWidth);
      centerShiftX = (width - start.width) / 2;
    }
    if (handle.includes("w")) {
      width = clamp(start.width - delta.x, minWidth, maxWidth);
      centerShiftX = (start.width - width) / 2;
    }
    if (handle.includes("s")) {
      height = clamp(start.height + delta.y, minHeight, maxHeight);
      centerShiftY = (height - start.height) / 2;
    }
    if (handle.includes("n")) {
      height = clamp(start.height - delta.y, minHeight, maxHeight);
      centerShiftY = (start.height - height) / 2;
    }
  }
  const stageShift = layerOffsetToStage(centerShiftX, centerShiftY, rotation, stage);
  return {
    x: centerX + stageShift.x - width / 2,
    y: centerY + stageShift.y - height / 2,
    width,
    height,
  };
}

/**
 * Where a point on the stage falls inside a layer, as fractions of that layer
 * (app.js:3605-3618). The crop editor works in these coordinates, because a
 * crop handle has to follow the pointer through the layer's own rotation. The
 * caller passes client coordinates and the stage's bounding box, since this
 * module never sees an event.
 */
export function localPointOnLayer(
  pointX: number,
  pointY: number,
  stage: StageRect,
  box: Rect,
  rotation = 0,
): Point {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const nx = (pointX - stage.left) / stage.width;
  const ny = (pointY - stage.top) / stage.height;
  const local = rotateDelta(nx - centerX, ny - centerY, rotation);
  return {
    x: (centerX + local.x - box.x) / box.width,
    y: (centerY + local.y - box.y) / box.height,
  };
}

/**
 * How far a layer overhangs each canvas edge, as a share of its own size
 * (app.js:519-527). The renderer turns this into a CSS inset clip.
 */
export function layerStageInset(
  x: number,
  y: number,
  width: number,
  height: number,
): { top: number; right: number; bottom: number; left: number } {
  if (!width || !height) return { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    top: Math.max(0, -y / height),
    right: Math.max(0, (x + width - 1) / width),
    bottom: Math.max(0, (y + height - 1) / height),
    left: Math.max(0, -x / width),
  };
}
