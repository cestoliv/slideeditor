import { describe, expect, it } from "vitest";
import type { Ratio } from "../schema/index.js";
import {
  applyCropValues,
  constrainOverlay,
  expandOverlayForCrop,
  getOverlayMetrics,
  initialOverlayWidth,
  INITIAL_OVERLAY_MAX_SIZE,
  layerOffsetToStage,
  layerStageInset,
  localPointOnLayer,
  MIN_CROP_SIZE,
  naturalOverlayHeight,
  overlayCrop,
  pointerDeltaInLayerAxes,
  resizeLayerRect,
  restoreOverlayAfterCrop,
  rotateDelta,
  type OverlayGeometry,
  type ResizeHandle,
} from "./overlay.js";
import { OUTPUT_WIDTH, outputHeight } from "./ratio.js";

const asset = { width: 400, height: 200 };
const portrait: Ratio = { w: 9, h: 16 };
const stage = { width: 1080, height: 1920 };

it("defaults the crop to the whole image", () => {
  expect(overlayCrop({ cropX: 0, cropY: 0, cropW: 1, cropH: 1 })).toEqual({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  });
  expect(overlayCrop({})).toEqual({ x: 0, y: 0, w: 1, h: 1 });
});

it("never lets a crop collapse or run past the image", () => {
  expect(overlayCrop({ cropX: 2, cropY: -1, cropW: 0.001, cropH: 5 })).toEqual({
    x: 0.95,
    y: 0,
    w: 0.05,
    h: 1,
  });
});

it("derives the height from the cropped aspect and the canvas aspect", () => {
  const metrics = getOverlayMetrics(
    { width: 0.5, cropX: 0, cropY: 0, cropW: 1, cropH: 1 },
    asset,
    { ratio: portrait },
  );
  expect(metrics.width).toBe(0.5);
  expect(metrics.height).toBeCloseTo(0.5 * (OUTPUT_WIDTH / 1920) * (200 / 400), 6);
});

it("keeps a stored height, because the user may have resized the overlay", () => {
  const metrics = getOverlayMetrics({ width: 0.5, height: 0.3 }, asset, {
    ratio: portrait,
  });
  expect(metrics.height).toBe(0.3);
});

// app.js:506 tests Number.isFinite, so a stored zero survives where a missing
// height would be recomputed. constrainOverlay repairs that zero, this does not.
it("keeps a stored height of zero rather than recomputing it", () => {
  expect(
    getOverlayMetrics({ width: 0.5, height: 0 }, asset, { ratio: portrait }).height,
  ).toBe(0);
});

it("measures the whole asset while the overlay is being cropped", () => {
  const overlay = { width: 0.5, cropX: 0.25, cropY: 0.25, cropW: 0.5, cropH: 0.5 };
  const cropped = getOverlayMetrics(overlay, asset, { ratio: portrait });
  const whole = getOverlayMetrics(overlay, asset, { ratio: portrait, full: true });
  expect(cropped.height).toBeCloseTo(whole.height, 6);
  const tall = getOverlayMetrics({ ...overlay, cropH: 1, cropY: 0 }, asset, {
    ratio: portrait,
  });
  expect(tall.height).toBeGreaterThan(whole.height);
  expect(
    getOverlayMetrics(overlay, asset, { ratio: portrait, cropping: true }).height,
  ).toBe(whole.height);
});

it("falls back to a square asset when the asset is missing", () => {
  expect(getOverlayMetrics({ width: 0.5 }, null, { ratio: portrait }).height).toBeCloseTo(
    0.5 * (OUTPUT_WIDTH / 1920),
    6,
  );
});

// The README promises that a ratio change never distorts an overlay. The pixel
// aspect of the image inside the overlay is what carries that promise.
describe("a ratio change never distorts an overlay", () => {
  const ratios: Ratio[] = [
    { w: 9, h: 16 },
    { w: 3, h: 4 },
    { w: 4, h: 5 },
    { w: 1, h: 1 },
    { w: 1.91, h: 1 },
  ];

  const renderedAspect = (width: number, height: number, ratio: Ratio) =>
    (width * OUTPUT_WIDTH) / (height * outputHeight(ratio));

  it("keeps the rendered aspect when the height is recomputed", () => {
    const overlay = { width: 0.5, cropX: 0.1, cropY: 0.2, cropW: 0.6, cropH: 0.5 };
    const crop = overlayCrop(overlay);
    const source = (asset.width * crop.w) / (asset.height * crop.h);
    for (const ratio of ratios) {
      const metrics = getOverlayMetrics(overlay, asset, { ratio });
      expect(
        renderedAspect(metrics.width, metrics.height, ratio),
        `ratio ${ratio.w}`,
      ).toBeCloseTo(source, 6);
    }
  });

  // This is the recompute applyProjectRatio runs at app.js:884-888. Without it
  // a stored height would keep its old share of a canvas that changed height.
  it("keeps the rendered aspect when a stored height is recomputed for the new ratio", () => {
    const overlay = { width: 0.5, height: 0.14, cropW: 1, cropH: 1 };
    const source = asset.width / asset.height;
    for (const ratio of ratios) {
      const height = naturalOverlayHeight(
        overlay.width,
        asset,
        ratio,
        overlayCrop(overlay),
      );
      const constrained = constrainOverlay({ ...overlay, height }, asset, ratio);
      expect(
        renderedAspect(constrained.width, constrained.height, ratio),
        `ratio ${ratio.w}`,
      ).toBeCloseTo(source, 6);
    }
  });
});

it("repairs a width, a height and a rotation out of range", () => {
  const constrained = constrainOverlay(
    { width: 0, height: 0, rotation: -450, cropW: 1, cropH: 1 },
    asset,
    portrait,
  );
  expect(constrained.width).toBe(0.34);
  expect(constrained.height).toBeCloseTo(0.34 * (OUTPUT_WIDTH / 1920) * 0.5, 6);
  expect(constrained.rotation).toBe(270);
  expect(constrainOverlay({ width: 9, height: 9 }, asset, portrait).width).toBe(2.4);
  expect(constrainOverlay({ width: 9, height: 9 }, asset, portrait).height).toBe(2.4);
});

it("leaves an overlay alone when its asset has not loaded", () => {
  const overlay = { width: 99, height: 99, rotation: 720 };
  expect(constrainOverlay(overlay, null, portrait)).toBe(overlay);
});

it("caps the first placement so an overlay never fills the slide", () => {
  expect(initialOverlayWidth(asset, portrait)).toBeLessThanOrEqual(
    INITIAL_OVERLAY_MAX_SIZE,
  );
  // A tall asset is capped by its height, so its width lands well below the cap.
  expect(initialOverlayWidth({ width: 1080, height: 1920 }, portrait)).toBeCloseTo(
    0.82,
    6,
  );
  // A small asset keeps its own pixel size rather than being blown up.
  expect(initialOverlayWidth({ width: 108, height: 108 }, portrait)).toBeCloseTo(0.1, 6);
  expect(initialOverlayWidth({ width: 0, height: 0 }, portrait)).toBe(0.34);
  expect(initialOverlayWidth(null, portrait)).toBe(0.34);
});

it("rotates a delta into the layer's axes and back", () => {
  const rotated = rotateDelta(1, 0, 90);
  expect(rotated.x).toBeCloseTo(0, 6);
  expect(rotated.y).toBeCloseTo(-1, 6);
  const square = { width: 1000, height: 1000 };
  const back = layerOffsetToStage(rotated.x, rotated.y, 90, square);
  expect(back.x).toBeCloseTo(1, 6);
  expect(back.y).toBeCloseTo(0, 6);
});

it("converts a pixel drag into canvas fractions", () => {
  expect(pointerDeltaInLayerAxes(108, 192, 0, stage)).toEqual({ x: 0.1, y: 0.1 });
});

it("reports how far a layer overhangs the canvas", () => {
  expect(layerStageInset(-0.1, 0, 0.5, 0.5)).toEqual({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0.2,
  });
  expect(layerStageInset(0, 0, 0, 0)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});

it("keeps the opposite edge fixed when a corner handle resizes", () => {
  const next = resizeLayerRect(
    { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    "se",
    // The brief writes this delta as { dx, dy }, but app.js:3580 reads delta.x
    // and delta.y, which is also what pointerDeltaInLayerAxes returns.
    { x: 0.1, y: 0.1 },
    { minWidth: 0.05, minHeight: 0.05, maxWidth: 1, maxHeight: 1 },
    stage,
  );
  expect(next.x).toBeCloseTo(0.2, 6);
  expect(next.y).toBeCloseTo(0.2, 6);
  expect(next.width).toBeCloseTo(0.5, 6);
});

describe("every handle keeps its opposite edge or corner fixed", () => {
  const start = { x: 0.2, y: 0.3, width: 0.4, height: 0.25 };
  const handles: ResizeHandle[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
  const limits = { minWidth: 0.04, minHeight: 0.025, maxWidth: 2.4, maxHeight: 2.4 };

  for (const handle of handles) {
    for (const delta of [
      { x: 0.07, y: 0.05 },
      { x: -0.07, y: -0.05 },
    ]) {
      it(`holds the anchor for ${handle} at ${delta.x}`, () => {
        const next = resizeLayerRect(start, handle, delta, limits, stage);
        if (handle.includes("e")) expect(next.x).toBeCloseTo(start.x, 6);
        if (handle.includes("w")) {
          expect(next.x + next.width).toBeCloseTo(start.x + start.width, 6);
        }
        if (handle.includes("s")) expect(next.y).toBeCloseTo(start.y, 6);
        if (handle.includes("n")) {
          expect(next.y + next.height).toBeCloseTo(start.y + start.height, 6);
        }
        // An axis the handle does not touch keeps both of its edges.
        if (!handle.includes("e") && !handle.includes("w")) {
          expect(next.x).toBeCloseTo(start.x, 6);
          expect(next.width).toBeCloseTo(start.width, 6);
        }
        if (!handle.includes("n") && !handle.includes("s")) {
          expect(next.y).toBeCloseTo(start.y, 6);
          expect(next.height).toBeCloseTo(start.height, 6);
        }
      });
    }
  }
});

it("holds the anchor of a rotated layer in its own axes", () => {
  const start = { x: 0.2, y: 0.3, width: 0.4, height: 0.25, rotation: 30 };
  const next = resizeLayerRect(
    start,
    "e",
    { x: 0.1, y: 0 },
    { minWidth: 0.04, minHeight: 0.025 },
    stage,
  );
  expect(next.width).toBeCloseTo(0.5, 6);
  // The centre moves by half the growth, taken along the layer's own x axis.
  const shift = layerOffsetToStage(0.05, 0, 30, stage);
  expect(next.x + next.width / 2).toBeCloseTo(start.x + start.width / 2 + shift.x, 6);
  expect(next.y + next.height / 2).toBeCloseTo(start.y + start.height / 2 + shift.y, 6);
});

it("clamps a resize to the limits it is given", () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const limits = { minWidth: 0.3, minHeight: 0.3, maxWidth: 0.5, maxHeight: 0.5 };
  expect(resizeLayerRect(start, "e", { x: 9, y: 0 }, limits, stage).width).toBe(0.5);
  expect(resizeLayerRect(start, "e", { x: -9, y: 0 }, limits, stage).width).toBe(0.3);
  expect(resizeLayerRect(start, "s", { x: 0, y: 9 }, limits, stage).height).toBe(0.5);
});

it("scales width and height together when the drag preserves the aspect", () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.2 };
  const next = resizeLayerRect(
    start,
    "se",
    { x: 0.04, y: 0.01 },
    { minWidth: 0.04, minHeight: 0.025, preserveAspect: true },
    { width: 1000, height: 1000 },
  );
  expect(next.width / next.height).toBeCloseTo(start.width / start.height, 6);
  expect(next.width).toBeGreaterThan(start.width);
  expect(next.x).toBeCloseTo(start.x, 6);
  expect(next.y).toBeCloseTo(start.y, 6);
});

describe("the crop rectangle a drag proposes", () => {
  it("keeps a rectangle that is already legal", () => {
    expect(applyCropValues({ x: 0, y: 0, w: 1, h: 1 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    expect(applyCropValues({ x: 0.2, y: 0.1, w: 0.5, h: 0.4 })).toEqual({
      x: 0.2,
      y: 0.1,
      w: 0.5,
      h: 0.4,
    });
  });

  it("floors a collapsed axis and leaves the origin where it is", () => {
    expect(applyCropValues({ x: 0.3, y: 0.3, w: 0, h: -0.2 })).toEqual({
      x: 0.3,
      y: 0.3,
      w: MIN_CROP_SIZE,
      h: MIN_CROP_SIZE,
    });
  });

  // A west or north handle drags the origin, so the floor has to hold the
  // opposite edge still instead (app.js:3627, app.js:3631).
  it("pins a collapsed axis to its anchor when the drag has one", () => {
    expect(
      applyCropValues({ x: 0.7, y: 0.6, w: -0.1, h: 0, anchorX: 0.6, anchorY: 0.5 }),
    ).toEqual({
      x: 0.6 - MIN_CROP_SIZE,
      y: 0.5 - MIN_CROP_SIZE,
      w: MIN_CROP_SIZE,
      h: MIN_CROP_SIZE,
    });
  });

  it("trims a rectangle that runs off the asset rather than moving it", () => {
    const off = applyCropValues({ x: -0.1, y: -0.2, w: 0.5, h: 0.6 });
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
    expect(off.w).toBeCloseTo(0.4, 9);
    expect(off.h).toBeCloseTo(0.4, 9);
    const wide = applyCropValues({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 });
    expect(wide.w).toBeCloseTo(0.2, 6);
    expect(wide.h).toBeCloseTo(0.1, 6);
  });

  it("keeps every result inside the asset, whatever the drag proposes", () => {
    const values = [-9, -0.4, -0.05, 0, 0.001, 0.3, 0.95, 1, 1.4, 9];
    const anchors = [undefined, null, -0.2, 0.4, 1.3];
    for (const x of values) {
      for (const w of values) {
        for (const anchorX of anchors) {
          const crop = applyCropValues({ x, y: x, w, h: w, anchorX, anchorY: anchorX });
          const label = JSON.stringify({ x, w, anchorX });
          expect(crop.x, label).toBeGreaterThanOrEqual(0);
          expect(crop.y, label).toBeGreaterThanOrEqual(0);
          expect(crop.w, label).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
          expect(crop.h, label).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
          expect(crop.x + crop.w, label).toBeLessThanOrEqual(1 + 1e-9);
          expect(crop.y + crop.h, label).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });
});

describe("a point on the stage, in a layer's own coordinates", () => {
  const square = { left: 0, top: 0, width: 1000, height: 1000 };
  const box = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  it("maps the layer's own corners to its unit square", () => {
    expect(localPointOnLayer(250, 250, square, box)).toEqual({ x: 0, y: 0 });
    expect(localPointOnLayer(500, 500, square, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(localPointOnLayer(750, 750, square, box)).toEqual({ x: 1, y: 1 });
  });

  it("takes the stage's own offset off the point", () => {
    const offset = { left: 40, top: 60, width: 1000, height: 1000 };
    expect(localPointOnLayer(540, 560, offset, box)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("follows the layer through its rotation", () => {
    // A quarter turn sends the stage's right edge to the layer's top edge.
    const local = localPointOnLayer(750, 500, square, box, 90);
    expect(local.x).toBeCloseTo(0.5, 6);
    expect(local.y).toBeCloseTo(0, 6);
  });
});

/** An overlay the crop editor works on, which may carry no height yet. */
type CropOverlay = OverlayGeometry & { x: number; y: number; rotation?: number };

describe("the crop editor's round trip", () => {
  const ratios: Ratio[] = [
    { w: 9, h: 16 },
    { w: 4, h: 5 },
    { w: 1.91, h: 1 },
  ];
  const crops = [
    { cropX: 0.25, cropY: 0.1, cropW: 0.5, cropH: 0.6 },
    { cropX: 0, cropY: 0.4, cropW: 1, cropH: 0.6 },
    { cropX: 0.05, cropY: 0.05, cropW: 0.9, cropH: 0.9 },
  ];

  // beginCrop (app.js:1035-1041) and exitCropMode (app.js:1053-1059) are
  // inverses. Any asymmetry drifts the overlay a little on every crop, and the
  // drift compounds because the result is what gets saved.
  it("puts the overlay back exactly where it started", () => {
    for (const ratio of ratios) {
      for (const crop of crops) {
        const overlay = {
          x: 0.12,
          y: 0.3,
          width: 0.4,
          height: 0.25,
          rotation: 12,
          ...crop,
        };
        const expanded = expandOverlayForCrop(overlay, asset, ratio);
        const restored = restoreOverlayAfterCrop(expanded, asset, ratio);
        const label = `${ratio.w}:${ratio.h} ${JSON.stringify(crop)}`;
        expect(restored.x, label).toBeCloseTo(overlay.x, 9);
        expect(restored.y, label).toBeCloseTo(overlay.y, 9);
        expect(restored.width, label).toBeCloseTo(overlay.width, 9);
        expect(restored.height, label).toBeCloseTo(overlay.height, 9);
        expect(restored.rotation, label).toBe(12);
      }
    }
  });

  // app.js:1037 widens the overlay and then measures it, which overstates the
  // natural height by 1 / crop.w on the path where no height is stored. This is
  // the assertion that pins the fix: the expanded box is the whole asset at the
  // expanded width, so re-measuring it with no crop must return the same height.
  it("measures the whole asset from the width it was handed, not the widened one", () => {
    const overlay: CropOverlay = {
      x: 0.12,
      y: 0.3,
      width: 0.4,
      cropX: 0.25,
      cropY: 0.1,
      cropW: 0.5,
      cropH: 0.6,
    };
    const before = getOverlayMetrics(overlay, asset, { ratio: portrait });
    expect(before.height).toBeCloseTo(0.135, 9);

    const expanded = expandOverlayForCrop(overlay, asset, portrait);
    expect(expanded.width).toBeCloseTo(0.8, 9);
    expect(expanded.height).toBeCloseTo(naturalOverlayHeight(0.8, asset, portrait), 9);
    // app.js's order returns 0.45 here, which doubles the overlay on its first
    // crop and is why this port does not follow it.
    expect(expanded.height).toBeCloseTo(0.225, 9);
    expect(expanded.height).not.toBeCloseTo(0.45, 3);
  });

  // An overlay saved without a height reaches exitCropMode with none, because
  // an identity crop makes beginCrop a no-op. app.js:1054 passes full: true so
  // the box is measured against the whole asset it is currently showing.
  it("measures the whole asset when the crop closes on an overlay with no stored height", () => {
    const overlay: CropOverlay = { x: 0.1, y: 0.2, width: 0.8, cropW: 1, cropH: 1 };
    const cropped = { ...overlay, cropX: 0.25, cropY: 0.1, cropW: 0.5, cropH: 0.6 };
    const restored = restoreOverlayAfterCrop(cropped, asset, portrait);

    expect(restored.width).toBeCloseTo(0.4, 9);
    // The restored box frames the new crop undistorted. Without full: true the
    // height comes out at 0.162 and the origin lands at 0.227.
    expect(restored.height).toBeCloseTo(
      naturalOverlayHeight(0.4, asset, portrait, overlayCrop(cropped)),
      9,
    );
    expect(restored.height).toBeCloseTo(0.135, 9);
    expect(restored.x).toBeCloseTo(0.3, 9);
    expect(restored.y).toBeCloseTo(0.2225, 9);
  });

  // An asymmetry between the two halves compounds, because each session starts
  // from what the last one saved. Six sessions with a different crop each time
  // is where that would show.
  it("holds the whole asset's box still across six crop sessions", () => {
    const sessions = [
      { cropX: 0.25, cropY: 0.1, cropW: 0.5, cropH: 0.6 },
      { cropX: 0, cropY: 0, cropW: 1, cropH: 1 },
      { cropX: 0.4, cropY: 0.35, cropW: 0.55, cropH: 0.6 },
      { cropX: 0.05, cropY: 0.45, cropW: 0.9, cropH: 0.55 },
      { cropX: 0.5, cropY: 0, cropW: 0.5, cropH: 0.35 },
      { cropX: 0.12, cropY: 0.08, cropW: 0.71, cropH: 0.83 },
      { cropX: 0.33, cropY: 0.33, cropW: 0.34, cropH: 0.34 },
    ];

    for (const height of [undefined, 0.25]) {
      const start = {
        x: 0.12,
        y: 0.3,
        width: 0.4,
        height,
        rotation: 12,
        ...sessions[6]!,
      };
      // The box the crop editor shows: the whole asset, wherever it sits.
      const box = expandOverlayForCrop(start, asset, portrait);
      let overlay = box;
      let drift = 0;

      for (const [index, crop] of sessions.entries()) {
        // The user drags the crop handles, then closes the editor.
        const restored = restoreOverlayAfterCrop(
          { ...overlay, ...crop },
          asset,
          portrait,
        );
        // Opening it again must show the same whole asset, in the same place.
        overlay = expandOverlayForCrop(restored, asset, portrait);
        const label = `session ${index} of ${String(height)}`;
        expect(overlay.x, label).toBeCloseTo(box.x, 12);
        expect(overlay.y, label).toBeCloseTo(box.y, 12);
        expect(overlay.width, label).toBeCloseTo(box.width, 12);
        expect(overlay.height, label).toBeCloseTo(box.height!, 12);
        drift = Math.max(
          drift,
          Math.abs(overlay.x - box.x),
          Math.abs(overlay.y - box.y),
          Math.abs(overlay.width - box.width),
          Math.abs(overlay.height! - box.height!),
        );
      }
      // Float noise only, and nowhere near a pixel of the 1080 wide canvas.
      expect(drift).toBeLessThan(1e-12);
    }
  });

  it("grows the overlay to the whole asset and keeps the visible part still", () => {
    const overlay = {
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.3,
      cropX: 0.25,
      cropY: 0.5,
      cropW: 0.5,
      cropH: 0.5,
    };
    const expanded = expandOverlayForCrop(overlay, asset, portrait);
    // Half the asset was showing, so the whole of it is twice as big.
    expect(expanded.width).toBeCloseTo(0.8, 9);
    expect(expanded.height).toBeCloseTo(0.6, 9);
    // The cropped region stays where the user last saw it.
    expect(expanded.x + 0.25 * expanded.width).toBeCloseTo(overlay.x, 9);
    expect(expanded.y + 0.5 * expanded.height).toBeCloseTo(overlay.y, 9);
  });

  it("leaves an overlay with no crop alone", () => {
    const overlay = { x: 0.1, y: 0.2, width: 0.4, height: 0.3, cropW: 1, cropH: 1 };
    expect(expandOverlayForCrop(overlay, asset, portrait)).toBe(overlay);
  });

  it("leaves an overlay alone when its asset has not loaded", () => {
    const overlay = {
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.3,
      cropX: 0.2,
      cropW: 0.5,
      cropH: 0.5,
    };
    const restored = restoreOverlayAfterCrop(overlay, null, portrait);
    expect(restored.width).toBeCloseTo(0.2, 9);
    expect(restored.height).toBeCloseTo(0.15, 9);
  });
});
