import type { CSSProperties, JSX } from "react";
import { Fragment } from "react";
import { outlineColorFor, textColorOf } from "@shared/geometry/index.js";
import {
  concaveCornerPath,
  fontStack,
  roundedRectPath,
  TEXT_WRAP_INSET,
} from "@shared/text/index.js";
import type { TextLayout } from "@shared/text/index.js";
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

/**
 * The pill colour, which is the box's own colour rather than the text's
 * (app.js:2822). textBackgroundSchema has already normalized it to hex by the
 * time a TextLayer reaches here, so this returns it as-is; the canvas exporter
 * (export/render.ts) reads it through this same function, which is what keeps
 * the two renderers from drifting apart.
 */
export function pillFillFor(layer: TextLayer): string {
  return layer.background;
}

/**
 * Where the block of lines sits inside the box.
 *
 * The block is the wrap column: the box less TEXT_WRAP_INSET, split evenly
 * between both sides. A left aligned line then starts at `textX`, a right
 * aligned one ends at it, and a centred one centres on it. The inline editor
 * is positioned from this same object, and the browser wraps its text at the
 * block's width. Any wider block lets the editor keep a word on a line that
 * the layout already broke.
 */
export function textBlockStyle(layout: TextLayout, layer: TextLayer): CSSProperties {
  const inset = `${String((layout.fontSize * TEXT_WRAP_INSET) / 2)}px`;
  return {
    left: inset,
    right: inset,
    top: `${String(layout.startY - layout.lineHeight / 2)}px`,
    height: `${String(layout.blockHeight)}px`,
    fontSize: `${String(layout.fontSize)}px`,
    lineHeight: `${String(layout.lineHeight)}px`,
    textAlign: layout.align,
    // The face and the weight are named from the layer's own family, and the
    // measuring canvas (useTextLayout.ts, render.ts) is bound to the same
    // string and the same weightFor(family, layer.weight) lookup. A
    // one-character difference between the two rewraps every line
    // (src/shared/text/constants.ts); a weight mismatch synthesises bold here
    // without doing so on the canvas.
    fontFamily: fontStack(layer.fontFamily),
    fontWeight: weightFor(layer.fontFamily, layer.weight),
    fontStyle: layer.italic ? "italic" : "normal",
    fontVariationSettings: opticalSizeOf(layout),
  };
}

/** Draws the stage's glyphs in the export's design, whatever the zoom (TextLayout.opticalSize). */
function opticalSizeOf(layout: TextLayout): string {
  return `"opsz" ${String(layout.opticalSize)}`;
}

export function renderTextDom(layer: TextLayer, layout: TextLayout): JSX.Element {
  const color = textColorOf(layer);
  const fill = pillFillFor(layer);
  const blockStyle: CSSProperties = {
    ...textBlockStyle(layout, layer),
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
      {layer.underline || layer.strikethrough ? (
        <svg className={styles.rules} aria-hidden="true" data-testid="text-rules">
          {layout.lines.map((_line, index) => {
            // A blank line has no glyphs to rule through. computeTextLayout
            // already decided which lines those are, and the pills above read
            // the same field.
            if (layout.pillVisible[index] !== true) return null;
            const left = layout.lineStarts[index] ?? 0;
            const width = layout.lineWidths[index] ?? 0;
            const center = layout.lineCenters[index] ?? 0;
            const rule = (offset: number, kind: string) => (
              <rect
                key={`${kind}-${String(index)}`}
                {...{ [`data-${kind}`]: index }}
                x={left}
                y={center + offset - layout.decorationThickness / 2}
                width={width}
                height={layout.decorationThickness}
                fill={color}
                stroke={layer.style === "outline" ? outlineColorFor(color) : undefined}
                strokeWidth={layer.style === "outline" ? layout.outlineWidth : undefined}
                strokeLinejoin="round"
                paintOrder="stroke fill"
              />
            );
            return (
              <Fragment key={index}>
                {layer.underline ? rule(layout.underlineOffset, "underline") : null}
                {layer.strikethrough
                  ? rule(layout.strikethroughOffset, "strikethrough")
                  : null}
              </Fragment>
            );
          })}
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
                fontWeight={weightFor(layer.fontFamily, layer.weight)}
                fontStyle={layer.italic ? "italic" : "normal"}
                fontSize={`${String(layout.fontSize)}px`}
                style={{ fontVariationSettings: opticalSizeOf(layout) }}
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
