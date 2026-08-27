import type { CSSProperties, JSX } from "react";
import { outlineColorFor, textColorOf } from "@shared/geometry/index.js";
import { fontStack } from "@shared/text/index.js";
import type { CornerRadii, JunctionCorner, TextLayout } from "@shared/text/index.js";
import type { TextLayer } from "@shared/schema/index.js";
import { weightFor } from "../../../app/fontFaces.js";
import styles from "./text.module.css";

/*
 * The only DOM renderer for a text layer. Ported from paintTextContent
 * (app.js:2851-2892) and createPerLineBackground (app.js:2811-2849).
 *
 * It computes nothing. Every coordinate below is read straight off the
 * TextLayout that computeTextLayout returned, which is the same object the PNG
 * exporter draws from. That is the whole point of the module: the editor and
 * the export cannot wrap a line differently or round a pill differently,
 * because neither one is allowed to work a number out for itself.
 */

/** The pill colour, which is the box's tone rather than the text's (app.js:2822). */
export function pillFillFor(layer: TextLayer): string {
  return layer.background === "black" ? "#111111" : "#ffffff";
}

/** Ported verbatim from roundedRectSvgPath (app.js:2785-2799). */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  [tl, tr, br, bl]: CornerRadii,
): string {
  return [
    `M ${String(x + tl)} ${String(y)}`,
    `H ${String(x + width - tr)}`,
    `Q ${String(x + width)} ${String(y)} ${String(x + width)} ${String(y + tr)}`,
    `V ${String(y + height - br)}`,
    `Q ${String(x + width)} ${String(y + height)} ${String(x + width - br)} ${String(
      y + height,
    )}`,
    `H ${String(x + bl)}`,
    `Q ${String(x)} ${String(y + height)} ${String(x)} ${String(y + height - bl)}`,
    `V ${String(y + tl)}`,
    `Q ${String(x)} ${String(y)} ${String(x + tl)} ${String(y)}`,
    "Z",
  ].join(" ");
}

/** Ported verbatim from concaveCornerSvgPath (app.js:2801-2809). */
export function concaveCornerPath({ cx, cy, radius, quadrant }: JunctionCorner): string {
  const up = `${String(cx)} ${String(cy - radius)}`;
  const down = `${String(cx)} ${String(cy + radius)}`;
  const centre = `${String(cx)} ${String(cy)}`;
  const left = `${String(cx - radius)} ${String(cy)}`;
  const right = `${String(cx + radius)} ${String(cy)}`;
  const arc = `A ${String(radius)} ${String(radius)} 0 0`;
  switch (quadrant) {
    case "upper-left":
      return `M ${up} L ${centre} L ${left} ${arc} 0 ${up} Z`;
    case "upper-right":
      return `M ${up} L ${centre} L ${right} ${arc} 1 ${up} Z`;
    case "lower-right":
      return `M ${down} L ${centre} L ${right} ${arc} 0 ${down} Z`;
    case "lower-left":
      return `M ${down} L ${centre} L ${left} ${arc} 1 ${down} Z`;
  }
}

/**
 * Where the block of lines sits inside the box.
 *
 * Only `textX` and `align` decide it, which is why no width is needed here: a
 * centred block spans the box, a left aligned one starts at the draw point, and
 * a right aligned one ends at it. The inline editor is positioned from this
 * same object, so the caret sits on the glyphs rather than near them.
 */
export function textBlockStyle(family: string, layout: TextLayout): CSSProperties {
  const vertical: CSSProperties = {
    top: `${String(layout.startY - layout.lineHeight / 2)}px`,
    height: `${String(layout.blockHeight)}px`,
    fontSize: `${String(layout.fontSize)}px`,
    lineHeight: `${String(layout.lineHeight)}px`,
    textAlign: layout.align,
    // The face and the weight are named from the layer's own family, and the
    // measuring canvas (useTextLayout.ts, render.ts) is bound to the same
    // string and the same weightFor(family) lookup. A one-character
    // difference between the two rewraps every line
    // (src/shared/text/constants.ts); a weight mismatch synthesises bold here
    // without doing so on the canvas.
    fontFamily: fontStack(family),
    fontWeight: weightFor(family),
  };
  if (layout.align === "left")
    return { ...vertical, left: `${String(layout.textX)}px`, right: 0 };
  if (layout.align === "right")
    return { ...vertical, left: 0, width: `${String(layout.textX)}px` };
  return { ...vertical, left: 0, right: 0 };
}

export function renderTextDom(layer: TextLayer, layout: TextLayout): JSX.Element {
  const color = textColorOf(layer);
  const fill = pillFillFor(layer);
  const blockStyle: CSSProperties = {
    ...textBlockStyle(layer.fontFamily, layout),
    color,
  };

  return (
    <div
      className={styles.visual}
      data-style={layer.style}
      data-shape={layer.backgroundShape}
      // styles.css:1855 and styles.css:1865 let an outline stroke and a pill
      // overhang the box; plain text is cut off at the edge instead.
      style={{ overflow: layer.style === "plain" ? "hidden" : "visible" }}
    >
      {layout.fullBox ? (
        <div
          className={styles.fullBackground}
          style={{
            borderRadius: `${String(layout.fullBoxRadius)}px`,
            background: fill,
          }}
        />
      ) : null}
      {layout.perLineBox ? (
        <svg className={styles.pills} aria-hidden="true" data-testid="text-pills">
          {layout.lines.map((_line, index) =>
            // app.js:4474 skips a blank line's pill, so a paragraph break leaves
            // a gap in the ribbon rather than a stray dot.
            layout.pillVisible[index] === true ? (
              <path
                key={index}
                data-pill={index}
                d={roundedRectPath(
                  layout.pillStarts[index] ?? 0,
                  (layout.lineCenters[index] ?? 0) - layout.pillHeight / 2,
                  layout.pillWidths[index] ?? 0,
                  layout.pillHeight,
                  layout.pillRadii[index] ?? [0, 0, 0, 0],
                )}
                fill={fill}
              />
            ) : null,
          )}
          {layout.junctions.map((corner, index) => (
            <path
              key={`junction-${String(index)}`}
              data-junction={index}
              d={concaveCornerPath(corner)}
              fill={fill}
            />
          ))}
        </svg>
      ) : null}
      <div className={styles.block} style={blockStyle} data-testid="text-block">
        {layout.lines.map((line, index) =>
          layer.style === "outline" ? (
            <svg
              key={index}
              className={styles.outlineLine}
              style={{ height: `${String(layout.lineHeight)}px` }}
              aria-hidden="true"
            >
              <text
                x={
                  layout.align === "left"
                    ? "0"
                    : layout.align === "right"
                      ? "100%"
                      : "50%"
                }
                y="50%"
                textAnchor={
                  layout.align === "left"
                    ? "start"
                    : layout.align === "right"
                      ? "end"
                      : "middle"
                }
                dominantBaseline="middle"
                fill={color}
                stroke={outlineColorFor(color)}
                strokeWidth={layout.outlineWidth}
                strokeLinejoin="round"
                strokeLinecap="round"
                paintOrder="stroke fill"
                fontFamily={fontStack(layer.fontFamily)}
                fontWeight={weightFor(layer.fontFamily)}
                fontSize={`${String(layout.fontSize)}px`}
              >
                {line === "" ? " " : line}
              </text>
            </svg>
          ) : (
            <span
              key={index}
              className={styles.line}
              style={{
                height: `${String(layout.lineHeight)}px`,
                lineHeight: `${String(layout.lineHeight)}px`,
              }}
            >
              {line === "" ? " " : line}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
