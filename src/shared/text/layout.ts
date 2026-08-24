import { DESIGN_WIDTH } from "../geometry/ratio.js";
import type { TextLayer } from "../schema/document.js";
import {
  BOX_CORNER_RADIUS,
  BOX_FULL_CORNER_RADIUS,
  BOX_HORIZONTAL_PADDING,
  BOX_JUNCTION_RADIUS,
  BOX_LINE_HEIGHT,
  BOX_TEXT_LINE_HEIGHT,
  OUTLINE_RATIO,
  TEXT_HORIZONTAL_INSET,
  TEXT_LINE_HEIGHT,
  TEXT_VERTICAL_PADDING,
  TEXT_WRAP_INSET,
} from "./constants.js";
import { lineCornerRadii, lineJunctionCorners } from "./pill.js";
import type { CornerRadii, JunctionCorner } from "./pill.js";
import { wrapText } from "./wrap.js";
import type { MeasureText } from "./wrap.js";

export type TextAlign = "left" | "center" | "right";

/**
 * The font size to lay a layer out at, for a render surface `renderWidth` pixels
 * wide. `layer.size` is authored against DESIGN_WIDTH, so every caller scaled it
 * itself before entering the module: app.js:2724, app.js:2737 and app.js:4439 all
 * write this same expression. It lives here so nothing is left for them to derive.
 */
export function fontSizeAt(layer: TextLayer, renderWidth: number): number {
  return layer.size * (renderWidth / DESIGN_WIDTH);
}

/** Keeps a pill's corner radii inside its own half-width, the way both draw paths do. */
function clampRadii(radii: CornerRadii, limit: number): CornerRadii {
  return [
    Math.min(radii[0], limit),
    Math.min(radii[1], limit),
    Math.min(radii[2], limit),
    Math.min(radii[3], limit),
  ];
}

export type TextLayoutInput = {
  layer: TextLayer;
  /** Width of the layer's box in pixels at the target scale. */
  boxWidth: number;
  /** Height of the layer's box in pixels at the target scale. */
  boxHeight: number;
  /** Font size in pixels at the target scale. */
  fontSize: number;
  /** Measures a line in the same font and at the same scale as the box. */
  measure: MeasureText;
};

/**
 * Everything a renderer needs to draw one text layer. Every coordinate is in
 * pixels at the target scale, measured from the box's top-left corner, before
 * the layer's own rotation is applied.
 */
export type TextLayout = {
  /** Wrapped lines, clipped to the ones that fit the box height. */
  lines: string[];
  /**
   * How many lines the text wrapped to before clipping. Greater than
   * `lines.length` when the box dropped lines, but never below one, so a single
   * line taller than its box reports no dropped lines and still does not fit.
   * The overflow test is `contentHeight > boxHeight`.
   */
  totalLineCount: number;
  /**
   * Height the box would need to show every wrapped line. This is what
   * ensureTextFits (app.js:2931-2947) reads off `scrollHeight` today, so a
   * renderer can grow the box without measuring the DOM a second time.
   */
  contentHeight: number;
  /** The font size the caller asked for, echoed so renderers read one object. */
  fontSize: number;
  /** Distance from one line's centre to the next. */
  lineHeight: number;
  /** True when each line gets its own pill rather than one background behind all of them. */
  perLineBox: boolean;
  /** True when the whole box is filled with one rounded background. */
  fullBox: boolean;
  /** Corner radius of that full-box background. */
  fullBoxRadius: number;
  /** Total height of the drawn lines. */
  blockHeight: number;
  /** Centre of the first line, from the box's top edge. */
  startY: number;
  /** Centre of each line, from the box's top edge. */
  lineCenters: number[];
  /** Per-line pill width, capped at boxWidth. */
  pillWidths: number[];
  /** Left edge of each pill for the chosen alignment, from the box's left edge. */
  pillStarts: number[];
  /** Whether each line's pill is drawn at all. An empty line gets none. */
  pillVisible: boolean[];
  /** Height of every pill. Taller than lineHeight, so neighbours overlap. */
  pillHeight: number;
  /** Corner radii of each pill, rounded only where no neighbour covers the edge. */
  pillRadii: CornerRadii[];
  /** Concave notches that join pills of different widths into one ribbon. */
  junctions: JunctionCorner[];
  /** Draw x for the chosen alignment, from the box's left edge. */
  textX: number;
  /** The alignment the geometry above was built for. */
  align: TextAlign;
  /** Padding added to each side of a pill. */
  horizontalPadding: number;
  /** Stroke width for the outline text style. */
  outlineWidth: number;
};

/**
 * Computes every number needed to draw one text layer, at whatever scale the
 * caller measures in.
 *
 * This is the merge of drawTextLayer (app.js:4431-4506) and paintTextContent
 * (app.js:2851-2892). Those two computed the same geometry twice, in two
 * languages, and drifted, so the editor stopped predicting the export. Callers
 * draw what this returns and derive nothing, which is what makes that drift
 * impossible rather than merely unlikely.
 *
 * Nothing here reads a font, a canvas, or the DOM. Measurement arrives through
 * `measure`, already bound to the target scale, so the same layer measured at
 * stage scale and at export scale returns proportional geometry.
 */
export function computeTextLayout(input: TextLayoutInput): TextLayout {
  const { layer, boxWidth, boxHeight, fontSize, measure } = input;
  const align: TextAlign = layer.align;
  const perLineBox = layer.style === "boxed" && layer.backgroundShape !== "full";
  const fullBox = layer.style === "boxed" && layer.backgroundShape === "full";
  const lineHeight = fontSize * (perLineBox ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT);
  const horizontalPadding = fontSize * BOX_HORIZONTAL_PADDING;
  const verticalPadding = fontSize * TEXT_VERTICAL_PADDING;

  const wrapWidth = Math.max(1, boxWidth - fontSize * TEXT_WRAP_INSET);
  const wrapped = wrapText(layer.text, wrapWidth, measure);
  // At least one line survives even in a box too short to hold one, because a
  // layer that renders nothing is indistinguishable from a lost layer.
  const visibleLineCount = Math.max(
    1,
    Math.floor((boxHeight - verticalPadding * 2) / lineHeight),
  );
  const lines = wrapped.slice(0, visibleLineCount);

  const blockHeight = lines.length * lineHeight;
  const startY = (boxHeight - blockHeight) / 2 + lineHeight / 2;
  const lineCenters = lines.map((_, index) => startY + index * lineHeight);

  // An empty line still measures as a space, so a paragraph break keeps the
  // pill stack's rhythm even though nothing is drawn on it.
  const pillWidths = lines.map((line) =>
    Math.min(measure(line || " ") + (perLineBox ? horizontalPadding * 2 : 0), boxWidth),
  );
  const pillStarts = pillWidths.map((pillWidth) =>
    align === "left"
      ? 0
      : align === "right"
        ? boxWidth - pillWidth
        : (boxWidth - pillWidth) / 2,
  );
  const pillVisible = lines.map((line) => line !== "");

  const pillHeight = fontSize * BOX_LINE_HEIGHT;
  const cornerRadius = Math.min(fontSize * BOX_CORNER_RADIUS, pillHeight / 2);
  const junctionRadius = Math.min(fontSize * BOX_JUNCTION_RADIUS, pillHeight / 2);
  // Both current paths clamp the radius against the pill's own width when they
  // draw, roundedRectSvgPath per corner (app.js:2786) and canvas roundRect by
  // its own spec. Clamping here instead keeps that out of the renderers.
  const pillRadii = lines.map((_, index) =>
    clampRadii(
      lineCornerRadii(pillWidths, index, cornerRadius),
      (pillWidths[index] ?? 0) / 2,
    ),
  );
  // Left and right aligned stacks share a flat edge, so they need no notches.
  const junctions =
    perLineBox && align === "center"
      ? lineJunctionCorners(
          pillWidths,
          lineCenters,
          boxWidth / 2,
          pillHeight,
          junctionRadius,
        )
      : [];

  const textX =
    align === "left"
      ? fontSize * TEXT_HORIZONTAL_INSET
      : align === "right"
        ? boxWidth - fontSize * TEXT_HORIZONTAL_INSET
        : boxWidth / 2;

  return {
    lines,
    totalLineCount: wrapped.length,
    contentHeight: wrapped.length * lineHeight + verticalPadding * 2,
    fontSize,
    lineHeight,
    perLineBox,
    fullBox,
    fullBoxRadius: Math.min(
      fontSize * BOX_FULL_CORNER_RADIUS,
      boxWidth / 2,
      boxHeight / 2,
    ),
    blockHeight,
    startY,
    lineCenters,
    pillWidths,
    pillStarts,
    pillVisible,
    pillHeight,
    pillRadii,
    junctions,
    textX,
    align,
    horizontalPadding,
    outlineWidth: fontSize * OUTLINE_RATIO,
  };
}
