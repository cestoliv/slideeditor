/** Corner radii of one pill, in the CSS order top-left, top-right, bottom-right, bottom-left. */
export type CornerRadii = [number, number, number, number];

/** Which way a concave notch faces, naming the quadrant of the circle it fills. */
export type JunctionQuadrant =
  "upper-left" | "upper-right" | "lower-right" | "lower-left";

/**
 * One concave notch where two pills of different widths meet. `cx`/`cy` are the
 * centre of the circle the notch is cut from, in the same coordinate space as
 * the pill geometry the caller passed in.
 */
export type JunctionCorner = {
  cx: number;
  cy: number;
  radius: number;
  quadrant: JunctionQuadrant;
};

/**
 * Corner radii for one line's pill, ported from app.js:2749-2757.
 *
 * An edge is rounded only where nothing covers it: the outermost lines, and any
 * line that overhangs its neighbour. Rounding an edge that a neighbour already
 * covers would carve a visible bite out of the joined shape.
 */
export function lineCornerRadii(
  widths: number[],
  index: number,
  radius: number,
): CornerRadii {
  const width = widths[index] ?? 0;
  const above = widths[index - 1];
  const below = widths[index + 1];
  // The slop keeps a barely-wider neighbour from producing a hairline step.
  //
  // app.js:2753 floors this at 2 absolute pixels. That floor is deleted here,
  // deliberately, and it is the only place this module departs from app.js. It
  // is one of two numbers in the pill geometry that did not scale with the font,
  // so below a 37.04px font the stage and the export disagreed about whether a
  // corner is rounded at all, which is a whole radius of difference and exactly
  // the drift this module exists to remove. See task-5-report.md.
  const slop = radius * 0.2;
  const top = above == null || width > above + slop;
  const bottom = below == null || width > below + slop;
  return [top ? radius : 0, top ? radius : 0, bottom ? radius : 0, bottom ? radius : 0];
}

/**
 * Concave notches for every boundary between two pills, ported from app.js:2759-2783.
 *
 * Where a narrow pill sits above a wide one, the notch belongs to the upper
 * pill's baseline, and where a wide one sits above a narrow one it belongs to
 * the lower edge of the wide pill. Filling those notches is what turns a stack
 * of rectangles into one continuous ribbon.
 *
 * `lineCenters` and `boxHeight` describe the pills, so the caller decides
 * whether the coordinates are stage pixels or export pixels. Only centred text
 * gets notches, because a left or right aligned stack meets on a flat edge.
 */
export function lineJunctionCorners(
  widths: number[],
  lineCenters: number[],
  centerX: number,
  boxHeight: number,
  radius: number,
): JunctionCorner[] {
  const corners: JunctionCorner[] = [];
  for (let index = 0; index < widths.length - 1; index += 1) {
    const upperWidth = widths[index] ?? 0;
    const lowerWidth = widths[index + 1] ?? 0;
    const sideGap = Math.abs(upperWidth - lowerWidth) / 2;
    // app.js:2765 floors this threshold at 1 absolute pixel. Deleted for the
    // same reason as the corner slop above, and recorded in the same place. This
    // one reaches higher, biting below a 55.56px font rather than 37.04, because
    // the junction radius is 0.18 of the font where the corner radius is 0.27.
    if (sideGap <= radius * 0.1) continue;
    const cornerRadius = Math.min(radius, sideGap);

    if (upperWidth < lowerWidth) {
      const boundaryY = (lineCenters[index + 1] ?? 0) - boxHeight / 2;
      corners.push(
        {
          cx: centerX - upperWidth / 2,
          cy: boundaryY,
          radius: cornerRadius,
          quadrant: "upper-left",
        },
        {
          cx: centerX + upperWidth / 2,
          cy: boundaryY,
          radius: cornerRadius,
          quadrant: "upper-right",
        },
      );
    } else {
      const boundaryY = (lineCenters[index] ?? 0) + boxHeight / 2;
      corners.push(
        {
          cx: centerX - lowerWidth / 2,
          cy: boundaryY,
          radius: cornerRadius,
          quadrant: "lower-left",
        },
        {
          cx: centerX + lowerWidth / 2,
          cy: boundaryY,
          radius: cornerRadius,
          quadrant: "lower-right",
        },
      );
    }
  }
  return corners;
}
