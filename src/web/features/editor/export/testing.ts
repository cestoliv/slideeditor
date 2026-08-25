import { page } from "vitest/browser";
import { parseDocument } from "@shared/schema/index.js";
import type {
  LibraryItem,
  Slide,
  SlideDocument,
  TextLayer,
} from "@shared/schema/index.js";
import { computeTextLayout, fontSizeAt, textFontString } from "@shared/text/index.js";
import type { MeasureText, TextLayout } from "@shared/text/index.js";

/*
 * Fixtures and pixel arithmetic for the export tests.
 *
 * Nothing here is a fixture file on disk. Every image is painted by the browser
 * into a data URL, so a test says what its pixels are instead of asking the
 * reader to open a PNG.
 */

/** Paints an image and hands it back as a data URL an <img> can load. */
export function paintedImage(
  width: number,
  height: number,
  paint: (context: CanvasRenderingContext2D) => void,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser gave no 2d canvas context.");
  paint(context);
  return canvas.toDataURL("image/png");
}

/** One flat colour, for a probe that has to know exactly what it is looking at. */
export function solidImage(width: number, height: number, color: string): string {
  return paintedImage(width, height, (context) => {
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
  });
}

/**
 * A smooth two-axis wash.
 *
 * The parity fixtures need a background with no hard edges anywhere. The stage
 * draws it through the browser's image scaler and the export draws it through
 * the canvas one, and the two disagree by a pixel or so on a sharp boundary, so
 * a checkerboard would measure the scalers rather than the renderers.
 */
export function gradientImage(
  width: number,
  height: number,
  from: string,
  to: string,
): string {
  return paintedImage(width, height, (context) => {
    const wash = context.createLinearGradient(0, 0, width, height);
    wash.addColorStop(0, from);
    wash.addColorStop(1, to);
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
  });
}

/** Four flat quadrants, so a crop or a rotation is readable from one pixel. */
export function quadrantImage(size: number): string {
  return paintedImage(size, size, (context) => {
    const half = size / 2;
    const quadrants: [string, number, number][] = [
      ["#ff0000", 0, 0],
      ["#00ff00", half, 0],
      ["#0000ff", 0, half],
      ["#ffff00", half, half],
    ];
    for (const [color, x, y] of quadrants) {
      context.fillStyle = color;
      context.fillRect(x, y, half, half);
    }
  });
}

export function libraryItem(
  id: string,
  url: string,
  width: number,
  height: number,
): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    mediaId: id,
    ext: "png",
    url,
    width,
    height,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 1, slideshowCount: 1, firstUsedAt: 1, lastUsedAt: 1 },
  };
}

export type SlideSeed = {
  backgroundItemId?: string;
  width?: number;
  height?: number;
  imageScale?: number;
  imageX?: number;
  imageY?: number;
  overlays?: unknown[];
  texts?: unknown[];
};

/**
 * One slide, built through parseDocument so a fixture cannot describe a
 * document the real parser would repair into something else.
 */
export function slideFixture(seed: SlideSeed = {}): Slide {
  const document: SlideDocument = parseDocument({
    ratio: { w: 9, h: 16 },
    slides: [
      {
        id: "slide-1",
        backgroundItemId: seed.backgroundItemId ?? "background",
        name: "Slide one",
        width: seed.width ?? 1080,
        height: seed.height ?? 1920,
        imageScale: seed.imageScale ?? 1,
        imageX: seed.imageX ?? 0,
        imageY: seed.imageY ?? 0,
        overlays: seed.overlays ?? [],
        texts: seed.texts ?? [],
      },
    ],
  });
  const slide = document.slides[0];
  if (slide === undefined) throw new Error("The fixture document held no slide.");
  return slide;
}

/**
 * The layout both renderers are handed, recomputed by the test.
 *
 * This is the expectation the corner probes are checked against, and it is a
 * third copy of the two callers' shared expressions on purpose: render.ts and
 * useTextLayout.ts each build boxWidth, boxHeight and fontSize the same way, so
 * a test that derived them from either one could not tell whether that one had
 * drifted. Deriving them here from the layer and the render size alone is the
 * only version that can.
 */
export function layoutAt(
  layer: TextLayer,
  renderWidth: number,
  renderHeight: number,
): TextLayout {
  const fontSize = fontSizeAt(layer, renderWidth);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser gave no 2d canvas context.");
  context.font = textFontString(fontSize);
  const measure: MeasureText = (line) => context.measureText(line).width;
  return computeTextLayout({
    layer,
    boxWidth: layer.width * renderWidth,
    boxHeight: layer.height * renderHeight,
    fontSize,
    measure,
  });
}

export type Rgba = [number, number, number, number];

/** One pixel of a rendered canvas, as four channels. */
export function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): Rgba {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("This browser gave no 2d canvas context.");
  const data = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
}

/** True when two colours are the same to within `tolerance` on every channel. */
export function sameColor(a: Rgba, b: Rgba, tolerance = 12): boolean {
  return a.every((channel, index) => Math.abs(channel - (b[index] ?? 0)) <= tolerance);
}

/** Names the nearest of a set of known colours, so a failure reads as a colour. */
export function nearestName(
  pixel: Rgba,
  palette: Record<string, Rgba>,
  tolerance = 24,
): string {
  for (const [name, color] of Object.entries(palette)) {
    if (sameColor(pixel, color, tolerance)) return name;
  }
  return `rgba(${pixel.join(", ")})`;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("The fixture image did not load."));
    };
    image.src = src;
  });
}

/**
 * Draws either render into one canvas of a known size and reads the pixels back.
 *
 * The stage paints at whatever the workspace gave it and the export paints at
 * 1080, so the two are only comparable once both have been resampled to the
 * same grid. `height` is passed rather than derived, because a screenshot is
 * measured in device pixels and its rounding need not land on the same aspect
 * the export canvas has.
 */
export async function normalise(
  source: HTMLCanvasElement | HTMLImageElement | string,
  width: number,
  height?: number,
): Promise<ImageData> {
  const image = typeof source === "string" ? await loadImageElement(source) : source;
  const sourceWidth =
    image instanceof HTMLCanvasElement ? image.width : image.naturalWidth;
  const sourceHeight =
    image instanceof HTMLCanvasElement ? image.height : image.naturalHeight;
  const target = height ?? Math.round((width * sourceHeight) / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = target;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("This browser gave no 2d canvas context.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, target);
  return context.getImageData(0, 0, width, target);
}

/** The per-channel difference above which two pixels count as different. */
export const CHANNEL_TOLERANCE = 12;

/**
 * The share of pixels the two renders disagree about.
 *
 * A pixel counts as different when any one channel is more than `threshold`
 * apart. At the default of 12 that counts every antialiased glyph edge the DOM
 * and the canvas shade differently, which is most of what the two disagree
 * about and none of what anyone would call drift. Raising the threshold keeps
 * a glyph that moved, because a displaced glyph swaps a light pixel for a dark
 * one rather than shading it.
 */
export function diffRatio(
  a: ImageData,
  b: ImageData,
  threshold: number = CHANNEL_TOLERANCE,
): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `Cannot compare ${String(a.width)}x${String(a.height)} against ${String(
        b.width,
      )}x${String(b.height)}.`,
    );
  }
  let differing = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      const left = a.data[index + channel] ?? 0;
      const right = b.data[index + channel] ?? 0;
      if (Math.abs(left - right) > threshold) {
        differing += 1;
        break;
      }
    }
  }
  return differing / (a.width * a.height);
}

/**
 * A screenshot of one element, as a data URL.
 *
 * `save: false` keeps the capture in memory. Saving would write a PNG into
 * `__screenshots__/`, which nothing ignores, so every run would leave the
 * working tree dirty.
 */
export async function screenshotDataUrl(element: Element): Promise<string> {
  const shot = await page.screenshot({ element, save: false });
  return `data:image/png;base64,${shot}`;
}
