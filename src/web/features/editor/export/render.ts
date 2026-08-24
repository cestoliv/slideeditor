import {
  OUTPUT_WIDTH,
  getImageLayout,
  getOverlayMetrics,
  outlineColorFor,
  overlayCrop,
  textColorOf,
} from "@shared/geometry/index.js";
import { computeTextLayout, fontSizeAt, textFontString } from "@shared/text/index.js";
import type { JunctionCorner, TextLayout } from "@shared/text/index.js";
import type {
  LibraryItem,
  Overlay,
  Ratio,
  Slide,
  TextLayer,
} from "@shared/schema/index.js";
import { slideItems } from "../selection.js";
import { pillFillFor } from "../text/renderTextDom.js";

/*
 * The only canvas renderer for a slide. Ported from renderSlideCanvas
 * (app.js:4228-4238), drawSlideLayers (app.js:4404-4409), drawOneOverlay
 * (app.js:4411-4429) and drawTextLayer (app.js:4431-4506).
 *
 * It computes no geometry of its own. Every text coordinate comes from
 * computeTextLayout and every overlay coordinate from src/shared/geometry, so
 * the exporter and the editor read one set of numbers rather than each working
 * them out. app.js:4431-4506 and app.js:2851-2892 did work them out separately,
 * in two languages, and drifted, which is why what the stage showed was not
 * what came out of the export.
 */

/**
 * The size the font is loaded at, matching app.js:4229 and useTextLayout.
 *
 * A size loads a face rather than a rendering, so this number never reaches a
 * glyph. It matches the stage's only so that neither path can be the one that
 * warms the cache.
 */
const FONT_LOAD_SIZE = 64;

export type RenderOptions = {
  /** Defaults to OUTPUT_WIDTH, which is what every export uses. */
  width?: number | undefined;
  /** The ratio's own output height (outputHeight), or a thumbnail's. */
  height: number;
  /** The library, by id. Every background and overlay resolves through it. */
  assets: ReadonlyMap<string, LibraryItem>;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error(`Could not load the image at ${src}.`));
    };
    image.src = src;
  });
}

/**
 * The ratio the canvas itself describes.
 *
 * getOverlayMetrics turns an overlay's width in canvas widths into a height in
 * canvas heights, and it needs the ratio to do it. Passing the canvas's own
 * dimensions rather than the document's ratio is exact rather than merely
 * close: outputAspect divides OUTPUT_WIDTH by outputHeight, which renormalises
 * whatever scale it is handed, so a 540-wide thumbnail and a 1080-wide export
 * of the same slide return the same aspect.
 */
function ratioOfCanvas(width: number, height: number): Ratio {
  return { w: width, h: height };
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser gave no 2d canvas context.");
  return context;
}

/**
 * Fills one concave notch between two pills, ported from fillConcaveCorner
 * (app.js:4568-4583).
 *
 * `offsetX` and `offsetY` move the notch from the layout's own origin, the
 * box's top-left corner, into the rotated frame the text is drawn in.
 */
function fillConcaveCorner(
  context: CanvasRenderingContext2D,
  corner: JunctionCorner,
  offsetX: number,
  offsetY: number,
): void {
  const cx = corner.cx + offsetX;
  const cy = corner.cy + offsetY;
  const { radius, quadrant } = corner;
  const shapes: Record<
    JunctionCorner["quadrant"],
    {
      start: [number, number];
      arcStart: [number, number];
      center: [number, number];
      from: number;
      to: number;
      counterClockwise: boolean;
    }
  > = {
    "upper-left": {
      start: [cx, cy - radius],
      arcStart: [cx - radius, cy],
      center: [cx - radius, cy - radius],
      from: Math.PI * 0.5,
      to: 0,
      counterClockwise: true,
    },
    "upper-right": {
      start: [cx, cy - radius],
      arcStart: [cx + radius, cy],
      center: [cx + radius, cy - radius],
      from: Math.PI * 0.5,
      to: Math.PI,
      counterClockwise: false,
    },
    "lower-right": {
      start: [cx, cy + radius],
      arcStart: [cx + radius, cy],
      center: [cx + radius, cy + radius],
      from: -Math.PI * 0.5,
      to: -Math.PI,
      counterClockwise: true,
    },
    "lower-left": {
      start: [cx, cy + radius],
      arcStart: [cx - radius, cy],
      center: [cx - radius, cy + radius],
      from: -Math.PI * 0.5,
      to: 0,
      counterClockwise: false,
    },
  };
  const shape = shapes[quadrant];
  context.beginPath();
  context.moveTo(shape.start[0], shape.start[1]);
  context.lineTo(cx, cy);
  context.lineTo(shape.arcStart[0], shape.arcStart[1]);
  context.arc(
    shape.center[0],
    shape.center[1],
    radius,
    shape.from,
    shape.to,
    shape.counterClockwise,
  );
  context.closePath();
  context.fill();
}

/** The pills, the notches and the full-box panel, all straight off the layout. */
function drawTextBackground(
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  layout: TextLayout,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
): void {
  const fill = pillFillFor(layer);
  if (layout.fullBox) {
    context.fillStyle = fill;
    context.beginPath();
    context.roundRect(x, y, boxWidth, boxHeight, layout.fullBoxRadius);
    context.fill();
  }
  if (!layout.perLineBox) return;
  context.fillStyle = fill;
  layout.lines.forEach((_line, index) => {
    // app.js:4474 skips a blank line's pill, so a paragraph break leaves a gap
    // in the ribbon rather than a stray dot.
    if (layout.pillVisible[index] !== true) return;
    context.beginPath();
    context.roundRect(
      x + (layout.pillStarts[index] ?? 0),
      y + (layout.lineCenters[index] ?? 0) - layout.pillHeight / 2,
      layout.pillWidths[index] ?? 0,
      layout.pillHeight,
      layout.pillRadii[index] ?? [0, 0, 0, 0],
    );
    context.fill();
  });
  for (const corner of layout.junctions) fillConcaveCorner(context, corner, x, y);
}

/**
 * One text layer, drawn from the layout and from nothing else.
 *
 * app.js:4431-4506 wrapped the lines, counted them, sized the pills and rounded
 * their corners here, all over again. Every one of those numbers now arrives on
 * `layout`, and this function only turns them into calls.
 */
function drawTextLayer(
  context: CanvasRenderingContext2D,
  layer: TextLayer,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const boxWidth = layer.width * canvasWidth;
  const boxHeight = layer.height * canvasHeight;
  const fontSize = fontSizeAt(layer, canvasWidth);
  const centerX = (layer.x + layer.width / 2) * canvasWidth;
  const centerY = (layer.y + layer.height / 2) * canvasHeight;
  const x = -boxWidth / 2;
  const y = -boxHeight / 2;

  context.save();
  context.translate(centerX, centerY);
  context.rotate((layer.rotation * Math.PI) / 180);
  // Set before the layout is computed, because `measure` below reads this very
  // context. The string comes from the shared module, so the measuring canvas
  // on the stage and this one cannot bind different faces.
  context.font = textFontString(fontSize);

  const layout = computeTextLayout({
    layer,
    boxWidth,
    boxHeight,
    fontSize,
    measure: (line) => context.measureText(line).width,
  });

  const color = textColorOf(layer);
  context.textAlign = layout.align;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineCap = "round";

  drawTextBackground(context, layer, layout, x, y, boxWidth, boxHeight);

  /*
   * The plain style is the one the stage cuts off at the box edge
   * (text.module.css sets overflow:hidden on it alone, ported from
   * styles.css:1855). app.js clipped nothing here, so a line taller than its
   * box was hidden on screen and printed in the export. Clipping is the
   * cheaper of the two ways to make them agree, and it only ever removes
   * pixels the editor never showed.
   */
  if (layer.style === "plain") {
    context.beginPath();
    context.rect(x, y, boxWidth, boxHeight);
    context.clip();
  }

  layout.lines.forEach((line, index) => {
    const lineX = x + layout.textX;
    const lineY = y + (layout.lineCenters[index] ?? 0);
    if (layer.style === "outline") {
      context.strokeStyle = outlineColorFor(color);
      context.lineWidth = layout.outlineWidth;
      context.strokeText(line, lineX, lineY);
    }
    context.fillStyle = color;
    context.fillText(line, lineX, lineY);
  });
  context.restore();
}

/** One photo overlay, cropped and rotated. Ported from app.js:4411-4429. */
async function drawOneOverlay(
  context: CanvasRenderingContext2D,
  overlay: Overlay,
  canvasWidth: number,
  canvasHeight: number,
  assets: ReadonlyMap<string, LibraryItem>,
): Promise<void> {
  const asset = assets.get(overlay.itemId) ?? null;
  if (asset === null) return;
  const image = await loadImage(asset.url);
  const metrics = getOverlayMetrics(overlay, asset, {
    ratio: ratioOfCanvas(canvasWidth, canvasHeight),
  });
  const width = metrics.width * canvasWidth;
  const height = metrics.height * canvasHeight;
  const x = overlay.x * canvasWidth;
  const y = overlay.y * canvasHeight;
  const crop = overlayCrop(overlay);
  /*
   * app.js:4421-4422 floored these two at one pixel. The floor is deleted here,
   * and it is the only place this function departs from that port.
   *
   * It was the last absolute pixel constant left in either renderer, which is
   * the exact shape src/shared/text/pill.ts had its two floors removed for. The
   * DOM path has no counterpart: OverlayLayer sizes its <img> at 100 / crop.w
   * per cent (OverlayLayer.tsx:169-172), which no floor touches, so on any
   * asset narrow enough for the floor to bite the stage and the export showed
   * different parts of the picture. That needs an asset under about twenty
   * pixels, because overlayCrop clamps the crop at MIN_CROP_SIZE, and a library
   * item that small is odd rather than impossible.
   *
   * Nothing here can reach zero and throw: MIN_CROP_SIZE is 0.05 and an image
   * that loaded has at least one pixel on each axis.
   */
  const sx = crop.x * image.naturalWidth;
  const sy = crop.y * image.naturalHeight;
  const sw = crop.w * image.naturalWidth;
  const sh = crop.h * image.naturalHeight;
  context.save();
  context.translate(x + width / 2, y + height / 2);
  context.rotate((overlay.rotation * Math.PI) / 180);
  context.drawImage(image, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
  context.restore();
}

/**
 * Every layer on the slide, back to front. slideItems is the same z-order the
 * stage stacks its DOM in, so an overlay above a text draws above it in both.
 */
async function drawSlideLayers(
  context: CanvasRenderingContext2D,
  slide: Slide,
  canvasWidth: number,
  canvasHeight: number,
  assets: ReadonlyMap<string, LibraryItem>,
): Promise<void> {
  for (const entry of slideItems(slide)) {
    if (entry.kind === "overlay") {
      await drawOneOverlay(context, entry.item, canvasWidth, canvasHeight, assets);
    } else {
      drawTextLayer(context, entry.item, canvasWidth, canvasHeight);
    }
  }
}

/**
 * Draws one slide to a canvas at the requested size.
 *
 * The font is awaited first. app.js:4449 set context.font to TikTok Sans and
 * measured immediately, so the first export of a cold page measured against a
 * fallback face and wrapped its lines somewhere else than the stage did.
 */
export async function renderSlideCanvas(
  slide: Slide,
  options: RenderOptions,
): Promise<HTMLCanvasElement> {
  const width = options.width ?? OUTPUT_WIDTH;
  const { height, assets } = options;
  await document.fonts.load(textFontString(FONT_LOAD_SIZE));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = contextOf(canvas);

  const background = assets.get(slide.backgroundItemId) ?? null;
  if (background !== null) {
    const image = await loadImage(background.url);
    // The slide carries the background's own pixel size (app.js:312-313), and
    // Stage.tsx measures from the same two fields, so a slide whose stored size
    // disagrees with the library item is off by the same amount in both.
    const layout = getImageLayout(slide, width, height);
    context.drawImage(image, layout.left, layout.top, layout.width, layout.height);
  }

  await drawSlideLayers(context, slide, width, height, assets);
  return canvas;
}

/** The same render, encoded as a PNG (app.js:4241-4245). */
export async function renderSlideBlob(
  slide: Slide,
  options: RenderOptions,
): Promise<Blob> {
  const canvas = await renderSlideCanvas(slide, options);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error("The browser could not encode the PNG."));
        else resolve(blob);
      },
      "image/png",
      1,
    );
  });
}
