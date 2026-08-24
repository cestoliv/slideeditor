import { expect, it } from "vitest";
import { lineCornerRadii, lineJunctionCorners } from "./pill.js";

it("rounds the top of the first line and the bottom of the last", () => {
  expect(lineCornerRadii([100, 100], 0, 10)).toEqual([10, 10, 0, 0]);
  expect(lineCornerRadii([100, 100], 1, 10)).toEqual([0, 0, 10, 10]);
});

it("rounds an edge that overhangs its neighbour", () => {
  expect(lineCornerRadii([200, 100], 0, 10)).toEqual([10, 10, 10, 10]);
});

it("adds concave corners where a narrow line sits above a wide one", () => {
  const corners = lineJunctionCorners([100, 200], [20, 60], 500, 40, 8);
  expect(corners).toHaveLength(2);
  expect(corners[0]!.quadrant).toBe("upper-left");
  expect(corners[1]!.quadrant).toBe("upper-right");
  expect(corners[0]!.cx).toBe(450);
});

it("adds no corner when two lines are nearly the same width", () => {
  expect(lineJunctionCorners([100, 101], [20, 60], 500, 40, 8)).toEqual([]);
});

it("adds concave corners below where a wide line sits above a narrow one", () => {
  const corners = lineJunctionCorners([200, 100], [20, 60], 500, 40, 8);
  expect(corners).toHaveLength(2);
  expect(corners[0]!.quadrant).toBe("lower-left");
  expect(corners[1]!.quadrant).toBe("lower-right");
  // The notch sits on the lower edge of the wide line, not the upper edge of
  // the narrow one, so the two pills meet without a seam.
  expect(corners[0]!.cy).toBe(40);
  expect(corners[0]!.cx).toBe(450);
});

it("never draws a notch wider than the overhang", () => {
  const corners = lineJunctionCorners([100, 106], [20, 60], 500, 40, 8);
  expect(corners[0]!.radius).toBe(3);
});

it("returns nothing for a single line", () => {
  expect(lineJunctionCorners([100], [20], 500, 40, 8)).toEqual([]);
});

// The next two pin the deletion of app.js's two absolute pixel floors. Both
// inputs sit inside the window where a floor and a proportional threshold
// disagree, so either floor coming back turns these red.

it("scales the corner slop with the radius instead of flooring it at two pixels", () => {
  // A radius of 6.48 is a 24px font. The slop is 1.296, so a 1.5px overhang
  // rounds. The old floor of 2 refused it, and the export, drawn at twice the
  // size, rounded it anyway.
  expect(lineCornerRadii([101.5, 100], 0, 6.48)).toEqual([6.48, 6.48, 6.48, 6.48]);
});

it("scales the junction threshold with the radius instead of flooring it at one pixel", () => {
  // Threshold 0.432 against a side gap of 0.6. The old floor of 1 dropped the
  // notch on the stage and kept it in the export.
  expect(lineJunctionCorners([100, 101.2], [20, 60], 500, 40, 4.32)).toHaveLength(2);
});
