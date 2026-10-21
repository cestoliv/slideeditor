import sharp from "sharp";
import {
  OUTPUT_WIDTH,
  getImageLayout,
  getOverlayMetrics,
  outlineColorFor,
  outputAspect,
  outputHeight,
  overlayCrop,
  overlaps,
  textColorOf,
} from "../../shared/geometry/index.js";
import { parseDocument } from "../../shared/schema/index.js";
import { outsideSafeZone } from "../../shared/compose/index.js";
import type { Box } from "../../shared/geometry/index.js";
import type { Overlay, Ratio, Slide, TextLayer } from "../../shared/schema/index.js";
import {
  TEXT_WEIGHT,
  computeTextLayout,
  concaveCornerPath,
  fontSizeAt,
  fontStack,
  roundedRectPath,
} from "../../shared/text/index.js";
import type { FontService } from "./fonts.js";
import type { LibraryService } from "./library.js";
import type { MediaStore } from "./media.js";

/*
 * An approximate server render of a slide, for an agent that cannot open the
 * editor. It follows export/render.ts layer for layer and, like it, computes no
 * geometry: text comes from computeTextLayout and images from
 * src/shared/geometry. Lines are measured with FontService.measureText at the
 * export's own size, from the face's own file, so a line wraps where the
 * export wraps it. librsvg draws the glyphs in whatever face it finds, which
 * for a Google family is another one, so every result says it is approximate.
 */

export type PreviewWarning = {
  /** 1-based, the way export_slideshow numbers slides. */
  slide: number;
  type: "text-out-of-frame" | "text-cut" | "overlay-over-text" | "outside-safe-zone";
  /** The text the warning is about, absent when it is about an image. */
  text?: string;
  /** The library item of the image the warning is about. */
  itemId?: string;
  message: string;
};

export type SlidePreview = {
  slide: number;
  width: number;
  height: number;
  jpeg: Buffer;
};

export type PreviewServices = {
  library: LibraryService;
  media: MediaStore;
  fonts: FontService;
};

/** Same rounding as thumbnailHeight, at any width: an even pixel count. */
export function previewHeight(ratio: Ratio, width: number): number {
  return Math.max(2, Math.round(width / outputAspect(ratio) / 2) * 2);
}

function escapeXml(value: string): string {
  // XML 1.0 forbids most control characters, and librsvg refuses the whole
  // document over one, so they go before the entities are written.
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu, "")
      .replace(
        /[&<>"']/g,
        (character) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[
            character
          ] ?? character,
      )
  );
}

/** A part of an image, in fractions of its own width and height. */
type Region = { x: number; y: number; w: number; h: number };

/**
 * The services, plus what a render reads once: each font family's default
 * weight, and the slide's height at the export's own width.
 */
type RenderServices = PreviewServices & {
  weights: ReadonlyMap<string, number>;
  exportHeight: number;
};

/**
 * The part of a library image a layer shows, cut out and resized to the pixels
 * it covers, as a data URI librsvg reads. This is drawImage's source
 * rectangle. Cutting first keeps the embedded bitmap no larger than what is
 * drawn, because librsvg refuses an SVG over 10 MB.
 */
async function imageHref(
  services: RenderServices,
  itemId: string,
  region: Region,
  width: number,
  height: number,
): Promise<string | null> {
  const item = services.library.get(itemId);
  if (item === null) return null;
  const image = sharp(await services.media.read(item.mediaId, item.ext));
  const {
    width: naturalWidth = 1,
    height: naturalHeight = 1,
    hasAlpha,
  } = await image.metadata();
  const left = Math.min(naturalWidth - 1, Math.floor(region.x * naturalWidth));
  const top = Math.min(naturalHeight - 1, Math.floor(region.y * naturalHeight));
  const cut = image
    .extract({
      left,
      top,
      width: Math.max(
        1,
        Math.min(naturalWidth - left, Math.round(region.w * naturalWidth)),
      ),
      height: Math.max(
        1,
        Math.min(naturalHeight - top, Math.round(region.h * naturalHeight)),
      ),
    })
    .resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), {
      fit: "fill",
    });
  // PNG only where transparency has to survive. JPEG is a tenth of the size.
  const [mime, bytes] = hasAlpha
    ? ["png", await cut.png().toBuffer()]
    : ["jpeg", await cut.jpeg({ quality: 90 }).toBuffer()];
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

/** One overlay, cropped and rotated the way drawOneOverlay draws it. */
async function overlaySvg(
  services: RenderServices,
  overlay: Overlay,
  width: number,
  height: number,
): Promise<{ svg: string; box: Box | null }> {
  const asset = services.library.get(overlay.itemId);
  const metrics = getOverlayMetrics(overlay, asset, { ratio: { w: width, h: height } });
  const w = metrics.width * width;
  const h = metrics.height * height;
  // ponytail: a stored overlay can be wider than the slide. Its bitmap is
  // capped at the canvas size, and the SVG still draws it at full size. A
  // full-slide photo with alpha at width 1080 can still pass librsvg's 10 MB
  // limit. Scale the PNG path to a byte budget if that shows up in practice.
  const href = await imageHref(
    services,
    overlay.itemId,
    overlayCrop(overlay),
    Math.min(w, width),
    Math.min(h, height),
  );
  if (href === null) return { svg: "", box: null };
  const svg =
    `<g transform="translate(${String(overlay.x * width + w / 2)} ${String(overlay.y * height + h / 2)}) rotate(${String(overlay.rotation)})">` +
    `<image x="${String(-w / 2)}" y="${String(-h / 2)}" width="${String(w)}" height="${String(h)}" preserveAspectRatio="none" href="${href}"/></g>`;
  const box = {
    x: overlay.x,
    y: overlay.y,
    width: metrics.width,
    height: metrics.height,
  };
  return { svg, box };
}

/** The part of the background on the canvas, and the canvas rectangle it fills. */
function visibleBackground(slide: Slide, width: number, height: number) {
  const layout = getImageLayout(slide, width, height);
  const fraction = (edge: number, start: number, size: number) =>
    Math.min(1, Math.max(0, (edge - start) / size));
  const x0 = fraction(0, layout.left, layout.width);
  const x1 = fraction(width, layout.left, layout.width);
  const y0 = fraction(0, layout.top, layout.height);
  const y1 = fraction(height, layout.top, layout.height);
  return {
    region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    left: layout.left + x0 * layout.width,
    top: layout.top + y0 * layout.height,
    width: (x1 - x0) * layout.width,
    height: (y1 - y0) * layout.height,
  };
}

/** One text layer, drawn from computeTextLayout the way drawTextLayer draws it. */
function textSvg(
  services: RenderServices,
  layer: TextLayer,
  width: number,
  height: number,
  clipId: string,
): { svg: string; cut: boolean } {
  // Laid out and drawn at the export's own size, then scaled to the preview,
  // as export/render.ts draws a thumbnail. The preview's rounded height and a
  // face's optical size would otherwise wrap and cut lines the export keeps.
  const scale = width / OUTPUT_WIDTH;
  const boxWidth = layer.width * OUTPUT_WIDTH;
  const boxHeight = layer.height * services.exportHeight;
  const fontSize = fontSizeAt(layer, OUTPUT_WIDTH);
  const font = {
    family: layer.fontFamily,
    size: fontSize,
    weight: layer.weight,
    italic: layer.italic,
  };
  const layout = computeTextLayout({
    layer,
    boxWidth,
    boxHeight,
    fontSize,
    measure: (line) => services.fonts.measureText(line, font),
  });
  const x = -boxWidth / 2;
  const y = -boxHeight / 2;
  const color = textColorOf(layer);
  const fill = escapeXml(layer.background);
  const parts: string[] = [];

  if (layout.fullBox) {
    parts.push(
      `<rect x="${String(x)}" y="${String(y)}" width="${String(boxWidth)}" height="${String(boxHeight)}" rx="${String(layout.fullBoxRadius)}" fill="${fill}"/>`,
    );
  }
  if (layout.perLineBox) {
    layout.lines.forEach((_line, index) => {
      if (layout.pillVisible[index] !== true) return;
      const d = roundedRectPath(
        x + (layout.pillStarts[index] ?? 0),
        y + (layout.lineCenters[index] ?? 0) - layout.pillHeight / 2,
        layout.pillWidths[index] ?? 0,
        layout.pillHeight,
        layout.pillRadii[index] ?? [0, 0, 0, 0],
      );
      parts.push(`<path d="${d}" fill="${fill}"/>`);
    });
    for (const corner of layout.junctions) {
      const shifted = { ...corner, cx: corner.cx + x, cy: corner.cy + y };
      parts.push(`<path d="${concaveCornerPath(shifted)}" fill="${fill}"/>`);
    }
  }

  const stroke =
    layer.style === "outline"
      ? ` stroke="${outlineColorFor(color)}" stroke-width="${String(layout.outlineWidth)}" stroke-linejoin="round" paint-order="stroke"`
      : "";
  const rules: string[] = [];
  layout.lines.forEach((_line, index) => {
    if (layout.pillVisible[index] !== true) return;
    const center = y + (layout.lineCenters[index] ?? 0);
    const rule = (offset: number) =>
      `<rect x="${String(x + (layout.lineStarts[index] ?? 0))}" y="${String(center + offset - layout.decorationThickness / 2)}" width="${String(layout.lineWidths[index] ?? 0)}" height="${String(layout.decorationThickness)}" fill="${color}"${stroke}/>`;
    if (layer.underline) rules.push(rule(layout.underlineOffset));
    if (layer.strikethrough) rules.push(rule(layout.strikethroughOffset));
  });
  const anchor =
    layout.align === "left" ? "start" : layout.align === "right" ? "end" : "middle";
  // Mirrors weightFor in the web catalogue: the layer's own weight, else the family's.
  const weight = layer.weight ?? services.weights.get(layer.fontFamily) ?? TEXT_WEIGHT;
  const glyphs = layout.lines.map(
    (line, index) =>
      `<text x="${String(x + layout.textX)}" y="${String(y + (layout.lineCenters[index] ?? 0))}" xml:space="preserve">${escapeXml(line)}</text>`,
  );
  // Plain text is the one style the stage cuts off at the box edge.
  const clip =
    layer.style === "plain"
      ? `<clipPath id="${clipId}"><rect x="${String(x)}" y="${String(y)}" width="${String(boxWidth)}" height="${String(boxHeight)}"/></clipPath>`
      : "";
  const centerX = (layer.x + layer.width / 2) * width;
  const centerY = (layer.y + layer.height / 2) * height;
  const svg =
    `<g transform="translate(${String(centerX)} ${String(centerY)}) rotate(${String(layer.rotation)}) scale(${String(scale)})">` +
    clip +
    parts.join("") +
    `<g${clip ? ` clip-path="url(#${clipId})"` : ""}>` +
    rules.join("") +
    `<g font-family="${escapeXml(fontStack(layer.fontFamily))}" font-size="${String(fontSize)}" font-weight="${String(weight)}" font-style="${layer.italic ? "italic" : "normal"}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central"${stroke}>` +
    glyphs.join("") +
    `</g></g></g>`;
  return { svg, cut: layout.totalLineCount > layout.lines.length };
}

/** Back to front, overlays before texts on a tie, the order slideItems stacks. */
function stacked(slide: Slide) {
  const layers = [
    ...slide.overlays.map((item) => ({ kind: "overlay" as const, item })),
    ...slide.texts.map((item) => ({ kind: "text" as const, item })),
  ];
  return layers.sort((a, b) => (Number(a.item.z) || 0) - (Number(b.item.z) || 0));
}

const SAFE_ZONE_MESSAGE =
  "This layer leaves the safe zone, where TikTok draws its tabs, caption or buttons over it. " +
  "A text past the right edge needs shorter lines or a narrower account text width, not an anchor.";

async function renderSlide(
  services: RenderServices,
  slide: Slide,
  number: number,
  width: number,
  height: number,
  warnings: PreviewWarning[],
): Promise<Buffer> {
  const parts: string[] = [];
  const visible = visibleBackground(slide, width, height);
  const href = await imageHref(
    services,
    slide.backgroundItemId,
    visible.region,
    visible.width,
    visible.height,
  );
  if (href !== null) {
    parts.push(
      `<image x="${String(visible.left)}" y="${String(visible.top)}" width="${String(visible.width)}" height="${String(visible.height)}" preserveAspectRatio="none" href="${href}"/>`,
    );
  }

  const texts: TextLayer[] = [];
  for (const [index, entry] of stacked(slide).entries()) {
    if (entry.kind === "overlay") {
      const { svg, box } = await overlaySvg(services, entry.item, width, height);
      parts.push(svg);
      if (box !== null && outsideSafeZone(box)) {
        warnings.push({
          slide: number,
          type: "outside-safe-zone",
          itemId: entry.item.itemId,
          message: SAFE_ZONE_MESSAGE,
        });
      }
      // ponytail: axis-aligned boxes, rotation ignored. Rotate the corners if
      // tilted layers start raising false alarms.
      for (const text of texts.filter((below) => box !== null && overlaps(box, below))) {
        warnings.push({
          slide: number,
          type: "overlay-over-text",
          text: text.text,
          message: "An image is drawn over this text and hides part of it.",
        });
      }
      continue;
    }
    const text = entry.item;
    texts.push(text);
    const { svg, cut } = textSvg(services, text, width, height, `clip-${String(index)}`);
    parts.push(svg);
    const epsilon = 1e-3;
    if (
      text.x < -epsilon ||
      text.y < -epsilon ||
      text.x + text.width > 1 + epsilon ||
      text.y + text.height > 1 + epsilon
    ) {
      warnings.push({
        slide: number,
        type: "text-out-of-frame",
        text: text.text,
        message: "This text box reaches past the edge of the slide.",
      });
    }
    if (outsideSafeZone(text)) {
      warnings.push({
        slide: number,
        type: "outside-safe-zone",
        text: text.text,
        message: SAFE_ZONE_MESSAGE,
      });
    }
    if (cut) {
      warnings.push({
        slide: number,
        type: "text-cut",
        text: text.text,
        message:
          "This text wraps to more lines than its box shows, so the last lines are cut.",
      });
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/**
 * Renders the chosen slides, 1-based, of a stored document. The document goes
 * through parseDocument first, so a slide a human saved with a missing field
 * renders with the same defaults the editor gives it.
 */
export async function renderPreview(
  services: PreviewServices,
  stored: { ratio: Ratio; slides: unknown[] },
  numbers: number[],
  width: number,
): Promise<{ slides: SlidePreview[]; warnings: PreviewWarning[] }> {
  const document = parseDocument(stored);
  const height = previewHeight(document.ratio, width);
  const warnings: PreviewWarning[] = [];
  const slides: SlidePreview[] = [];
  const weights = new Map(
    services.fonts.list().map((font) => [font.family, font.weight]),
  );
  const render = { ...services, weights, exportHeight: outputHeight(document.ratio) };
  for (const number of numbers) {
    const slide = document.slides[number - 1];
    if (slide === undefined) continue;
    const jpeg = await renderSlide(render, slide, number, width, height, warnings);
    slides.push({ slide: number, width, height, jpeg });
  }
  return { slides, warnings };
}
