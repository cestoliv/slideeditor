import { describe, expect, it } from "vitest";
import {
  constrainImagePosition,
  getImageLayout,
  PHOTO_ZOOM_MAX,
  PHOTO_ZOOM_MIN,
  zoomPhotoAtPoint,
  type ImageSlide,
} from "./image.js";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

// A float division leaves the odd sub-pixel behind, and no eye sees it.
const TOLERANCE = 1e-9;

/**
 * Places the photo at the offsets it is handed, with no clamp of its own.
 * getImageLayout clamps the pan internally, so feeding it a constrained slide
 * would re-clamp whatever it is given and hide the answer. This is the same
 * placement arithmetic with that clamp left out, which is what makes an
 * unclamped pan visible as the gap it would render. Every cover assertion goes
 * through here, because a helper built on getImageLayout cannot fail.
 */
const coversAtOffset = (
  slide: ImageSlide,
  imageX: number,
  imageY: number,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
) => {
  const scale =
    Math.max(canvasWidth / slide.width, canvasHeight / slide.height) *
    (slide.imageScale || 1);
  const width = slide.width * scale;
  const height = slide.height * scale;
  const left = (canvasWidth - width) / 2 + imageX * canvasWidth;
  const top = (canvasHeight - height) / 2 + imageY * canvasHeight;
  return (
    left <= TOLERANCE &&
    top <= TOLERANCE &&
    left + width >= canvasWidth - TOLERANCE &&
    top + height >= canvasHeight - TOLERANCE
  );
};

it("covers the canvas with an image wider than it", () => {
  const layout = getImageLayout(
    { width: 4000, height: 1000, imageScale: 1 },
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );
  expect(layout.height).toBeCloseTo(CANVAS_HEIGHT, 6);
  expect(layout.width).toBeGreaterThan(CANVAS_WIDTH);
  expect(layout.top).toBeCloseTo(0, 6);
  expect(layout.left).toBeCloseTo((CANVAS_WIDTH - layout.width) / 2, 6);
  // Only the overhanging axis can be panned.
  expect(layout.maxOffsetY).toBe(0);
  expect(layout.maxOffsetX).toBeGreaterThan(0);
});

it("covers the canvas with an image taller than it", () => {
  const layout = getImageLayout(
    { width: 1000, height: 4000, imageScale: 1 },
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );
  expect(layout.width).toBeCloseTo(CANVAS_WIDTH, 6);
  expect(layout.height).toBeGreaterThan(CANVAS_HEIGHT);
  expect(layout.left).toBeCloseTo(0, 6);
  expect(layout.maxOffsetX).toBe(0);
  expect(layout.maxOffsetY).toBeGreaterThan(0);
});

it("treats a missing scale as cover", () => {
  const layout = getImageLayout(
    { width: 1080, height: 1920 },
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );
  expect(layout.width).toBeCloseTo(CANVAS_WIDTH, 6);
  expect(layout.height).toBeCloseTo(CANVAS_HEIGHT, 6);
});

describe("the background never leaves a gap", () => {
  const assets = [
    { width: 4000, height: 1000 },
    { width: 1000, height: 4000 },
    { width: 1080, height: 1920 },
    { width: 100, height: 100 },
    { width: 4321, height: 1234 },
  ];
  // app.js writes imageScale only through clamp(value, 1, 3) (app.js:2462,
  // app.js:2693), so cover holds from 1 upward. A falsy scale reads as 1
  // (app.js:2645), which is why 0 and NaN belong here and 0.4 does not.
  // An infinite scale is left out because slideSchema parses imageScale with
  // z.number(), which zod 4 already rejects for Infinity and NaN alike.
  const scales = [1, 1.0001, 1.5, 2, 3, 0, Number.NaN];
  const pans = [0, 0.1, 0.5, 5, -5, -0.37, Number.NaN, Number.POSITIVE_INFINITY];

  // Every assertion below reads the numbers constrainImagePosition returns.
  // Handing them back to getImageLayout would prove nothing, because that
  // function clamps the pan itself and would repair a value the constrainer
  // failed to.
  const assertConstrained = (
    slide: ImageSlide,
    canvasWidth: number,
    canvasHeight: number,
  ) => {
    const label = JSON.stringify(slide);
    const limits = getImageLayout(slide, canvasWidth, canvasHeight);
    const { imageX, imageY } = constrainImagePosition(slide, canvasWidth, canvasHeight);

    expect(Number.isFinite(imageX), label).toBe(true);
    expect(Number.isFinite(imageY), label).toBe(true);
    // The pan it returns leaves no gap when it is honoured as it stands.
    expect(coversAtOffset(slide, imageX, imageY, canvasWidth, canvasHeight), label).toBe(
      true,
    );
    // And it sits inside the overhang, so nothing was merely zeroed out.
    expect(Math.abs(imageX), label).toBeLessThanOrEqual(limits.maxOffsetX + TOLERANCE);
    expect(Math.abs(imageY), label).toBeLessThanOrEqual(limits.maxOffsetY + TOLERANCE);
    // A pan already inside the overhang survives untouched, which is what
    // stops a constrainer from passing by pinning everything to zero.
    const rawX = slide.imageX || 0;
    const rawY = slide.imageY || 0;
    if (Math.abs(rawX) <= limits.maxOffsetX) expect(imageX, label).toBe(rawX);
    if (Math.abs(rawY) <= limits.maxOffsetY) expect(imageY, label).toBe(rawY);
  };

  it("returns a pan that covers the canvas at every scale and pan, hostile values included", () => {
    for (const asset of assets) {
      for (const imageScale of scales) {
        for (const imageX of pans) {
          for (const imageY of pans) {
            assertConstrained(
              { ...asset, imageScale, imageX, imageY },
              CANVAS_WIDTH,
              CANVAS_HEIGHT,
            );
          }
        }
      }
    }
  });

  it("covers a landscape canvas too", () => {
    for (const asset of assets) {
      for (const imageScale of scales) {
        assertConstrained({ ...asset, imageScale, imageX: 9, imageY: -9 }, 1080, 566);
      }
    }
  });
});

it("clamps a pan to the overhang the zoom leaves", () => {
  const slide = { width: 1080, height: 1920, imageScale: 2, imageX: 9, imageY: -9 };
  const position = constrainImagePosition(slide, CANVAS_WIDTH, CANVAS_HEIGHT);
  // At twice cover the photo overhangs by a whole canvas, so half of it can
  // slide past either edge.
  expect(position.imageX).toBeCloseTo(0.5, 6);
  expect(position.imageY).toBeCloseTo(-0.5, 6);
});

it("pins a photo that only just covers the canvas", () => {
  const slide = { width: 1080, height: 1920, imageScale: 1, imageX: 0.4, imageY: -0.4 };
  const position = constrainImagePosition(slide, CANVAS_WIDTH, CANVAS_HEIGHT);
  expect(position.imageX).toBeCloseTo(0, 6);
  expect(position.imageY).toBeCloseTo(0, 6);
});

// Ported as it stands from app.js:2645. Nothing in the app writes a scale below
// one, so getImageLayout does not defend against one, and a hand-edited or
// corrupt document letterboxes rather than covering.
it("letterboxes a photo whose stored scale sits below cover", () => {
  const layout = getImageLayout(
    { width: 1080, height: 1920, imageScale: 0.4 },
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );
  expect(layout.width).toBeCloseTo(CANVAS_WIDTH * 0.4, 6);
  expect(layout.left).toBeGreaterThan(0);
});

describe("zooming about a point", () => {
  const stage = { left: 40, top: 60, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const slide = { width: 1080, height: 1920, imageScale: 1, imageX: 0, imageY: 0 };

  it("keeps the point under the pointer where the pan allows", () => {
    const pointX = stage.left + 0.25 * CANVAS_WIDTH;
    const pointY = stage.top + 0.25 * CANVAS_HEIGHT;
    const before = getImageLayout(slide, CANVAS_WIDTH, CANVAS_HEIGHT);
    const imagePointX = (0.25 * CANVAS_WIDTH - before.left) / before.width;
    const next = zoomPhotoAtPoint(slide, 2, pointX, pointY, stage);
    const after = getImageLayout({ ...slide, ...next }, CANVAS_WIDTH, CANVAS_HEIGHT);
    expect(after.left + imagePointX * after.width).toBeCloseTo(0.25 * CANVAS_WIDTH, 6);
  });

  it("holds the photo inside its zoom band", () => {
    expect(zoomPhotoAtPoint(slide, 99, stage.left, stage.top, stage).imageScale).toBe(
      PHOTO_ZOOM_MAX,
    );
    expect(zoomPhotoAtPoint(slide, 0.1, stage.left, stage.top, stage).imageScale).toBe(
      PHOTO_ZOOM_MIN,
    );
  });

  // app.js:2685 guards this. React measures the stage after the first paint,
  // so a wheel event can arrive while the stage still reads 0 by 0.
  it("leaves the slide untouched when the stage has no size yet", () => {
    const panned = { ...slide, imageScale: 2, imageX: 0.3, imageY: -0.2 };
    const next = zoomPhotoAtPoint(panned, 3, 10, 10, {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    expect(next).toEqual({ imageScale: 2, imageX: 0.3, imageY: -0.2 });
    const bare = zoomPhotoAtPoint({ width: 1080, height: 1920 }, 3, 10, 10, {
      left: 0,
      top: 0,
      width: CANVAS_WIDTH,
      height: 0,
    });
    expect(bare).toEqual({ imageScale: 1, imageX: 0, imageY: 0 });
  });

  // app.js:2687-2688 clamps the focal point to the stage, so a pointer that has
  // left the stage zooms about the nearest edge instead of somewhere far away.
  // Removing that clamp leaves this green, because a focal point outside the
  // stage always asks for a pan past the cap and the pan clamp catches it
  // anyway. What this pins is the behaviour a user sees, not the clamp.
  it("treats a pointer outside the stage as one on its nearest edge", () => {
    const outside = zoomPhotoAtPoint(slide, 3, -9999, 9999, stage);
    const edge = zoomPhotoAtPoint(slide, 3, stage.left, stage.top + stage.height, stage);
    expect(outside).toEqual(edge);
    expect(
      coversAtOffset(
        { ...slide, imageScale: outside.imageScale },
        outside.imageX,
        outside.imageY,
      ),
    ).toBe(true);
    // At three times cover the photo overhangs by two canvases, so a whole one
    // can sit past either edge.
    expect(Math.abs(outside.imageX)).toBeLessThanOrEqual(1 + 1e-9);
  });

  // Zooming back out is where the pan has to be pulled in: the overhang the
  // photo was panned into stops existing, and app.js:2697 constrains for it.
  it("pulls a panned photo back in when the zoom comes out", () => {
    const panned = { ...slide, imageScale: 3, imageX: 0.9, imageY: -0.8 };
    const next = zoomPhotoAtPoint(panned, 1, stage.left + 540, stage.top + 960, stage);
    expect(next.imageScale).toBe(1);
    expect(next.imageX).toBeCloseTo(0, 12);
    expect(next.imageY).toBeCloseTo(0, 12);
    expect(coversAtOffset({ ...panned, imageScale: 1 }, next.imageX, next.imageY)).toBe(
      true,
    );
  });
});
