import { clamp } from "./math.js";

/** The editor's viewport zoom band (app.js:45-46). It scales the stage, never the photo. */
export const CANVAS_ZOOM_MIN = 0.2;
export const CANVAS_ZOOM_MAX = 3;

/** The background photo's own zoom band (app.js:2693). One means cover, and no less. */
export const PHOTO_ZOOM_MIN = 1;
export const PHOTO_ZOOM_MAX = 3;

/** The background fields of a slide, in the shapes getImageLayout reads. */
export interface ImageSlide {
  /** The background asset's own pixel width. */
  width: number;
  /** The background asset's own pixel height. */
  height: number;
  imageScale?: number;
  /** Pan, as a share of the canvas width, zero being centred. */
  imageX?: number;
  /** Pan, as a share of the canvas height, zero being centred. */
  imageY?: number;
}

export interface ImageLayout {
  width: number;
  height: number;
  left: number;
  top: number;
  maxOffsetX: number;
  maxOffsetY: number;
}

export interface ImagePosition {
  imageX: number;
  imageY: number;
}

export interface PhotoZoom extends ImagePosition {
  imageScale: number;
}

/** The stage's position and size on screen, in pixels. */
export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Places the background photo over the canvas (app.js:2644-2662). The photo
 * covers the canvas at any zoom, so the pan is capped at the overhang and the
 * canvas never shows a gap.
 */
export function getImageLayout(
  slide: ImageSlide,
  canvasWidth: number,
  canvasHeight: number,
): ImageLayout {
  const zoom = slide.imageScale || 1;
  const coverScale = Math.max(canvasWidth / slide.width, canvasHeight / slide.height);
  const scale = coverScale * zoom;
  const width = slide.width * scale;
  const height = slide.height * scale;
  const maxOffsetX = Math.max(0, (width - canvasWidth) / (2 * canvasWidth));
  const maxOffsetY = Math.max(0, (height - canvasHeight) / (2 * canvasHeight));
  const offsetX = clamp(slide.imageX || 0, -maxOffsetX, maxOffsetX);
  const offsetY = clamp(slide.imageY || 0, -maxOffsetY, maxOffsetY);
  return {
    width,
    height,
    left: (canvasWidth - width) / 2 + offsetX * canvasWidth,
    top: (canvasHeight - height) / 2 + offsetY * canvasHeight,
    maxOffsetX,
    maxOffsetY,
  };
}

/**
 * The pan a slide is allowed to keep (app.js:2664-2668). Returns the clamped
 * values rather than writing them back, so the caller owns the slide.
 */
export function constrainImagePosition(
  slide: ImageSlide,
  canvasWidth: number,
  canvasHeight: number,
): ImagePosition {
  const layout = getImageLayout(slide, canvasWidth, canvasHeight);
  return {
    imageX: clamp(slide.imageX || 0, -layout.maxOffsetX, layout.maxOffsetX),
    imageY: clamp(slide.imageY || 0, -layout.maxOffsetY, layout.maxOffsetY),
  };
}

/**
 * Zooms the background photo about a point on the stage (app.js:2682-2699). The
 * pixel under the pointer stays under the pointer, as far as the cover clamp
 * allows. pointX and pointY are client coordinates, which stage turns into
 * stage-relative ones.
 */
export function zoomPhotoAtPoint(
  slide: ImageSlide,
  nextScale: number,
  pointX: number,
  pointY: number,
  stage: StageRect,
): PhotoZoom {
  const canvasWidth = stage.width;
  const canvasHeight = stage.height;
  // app.js:2685 bails on a stage with no size, leaving the slide untouched.
  // React measures the stage after the first paint, so a wheel event can land
  // while the stage still reads 0 by 0, and without this every number below
  // comes back NaN.
  if (!canvasWidth || !canvasHeight) {
    return {
      imageScale: slide.imageScale ?? 1,
      imageX: slide.imageX ?? 0,
      imageY: slide.imageY ?? 0,
    };
  }
  const focalX = clamp(pointX - stage.left, 0, canvasWidth);
  const focalY = clamp(pointY - stage.top, 0, canvasHeight);
  const currentLayout = getImageLayout(slide, canvasWidth, canvasHeight);
  const imagePointX = (focalX - currentLayout.left) / currentLayout.width;
  const imagePointY = (focalY - currentLayout.top) / currentLayout.height;

  const imageScale = clamp(nextScale, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
  const zoomed = { ...slide, imageScale };
  const nextLayout = getImageLayout(zoomed, canvasWidth, canvasHeight);
  const panned = {
    ...zoomed,
    imageX:
      (focalX - imagePointX * nextLayout.width - (canvasWidth - nextLayout.width) / 2) /
      canvasWidth,
    imageY:
      (focalY -
        imagePointY * nextLayout.height -
        (canvasHeight - nextLayout.height) / 2) /
      canvasHeight,
  };
  return { imageScale, ...constrainImagePosition(panned, canvasWidth, canvasHeight) };
}
