import { expect, it } from "vitest";
import { computeTextLayout, fontSizeAt } from "./layout.js";
import { BOX_LINE_HEIGHT, TEXT_LINE_HEIGHT } from "./constants.js";

const measure = (line: string) => line.length * 10;
const base = {
  id: "t1",
  text: "one two three",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  size: 40,
  style: "plain" as const,
  color: "#FFFFFF",
  background: "white" as const,
  backgroundShape: "lines" as const,
  align: "center" as const,
  fontFamily: "TikTok Sans",
  rotation: 0,
  z: 1,
};

it("uses the plain line height when the layer is not a per-line box", () => {
  const layout = computeTextLayout({
    layer: base,
    boxWidth: 200,
    boxHeight: 200,
    fontSize: 40,
    measure,
  });
  expect(layout.perLineBox).toBe(false);
  expect(layout.lineHeight).toBeCloseTo(40 * TEXT_LINE_HEIGHT, 6);
});

it("uses the pill height when the layer is a per-line box", () => {
  const layer = { ...base, style: "boxed" as const, backgroundShape: "lines" as const };
  const layout = computeTextLayout({
    layer,
    boxWidth: 200,
    boxHeight: 200,
    fontSize: 40,
    measure,
  });
  expect(layout.perLineBox).toBe(true);
  expect(layout.pillHeight).toBeCloseTo(40 * BOX_LINE_HEIGHT, 6);
});

it("treats a full-box background as not per-line", () => {
  const layer = { ...base, style: "boxed" as const, backgroundShape: "full" as const };
  expect(
    computeTextLayout({ layer, boxWidth: 200, boxHeight: 200, fontSize: 40, measure })
      .perLineBox,
  ).toBe(false);
});

it("clips the lines that do not fit the box height", () => {
  const layer = { ...base, text: "a b c d e f g h i j k l" };
  const layout = computeTextLayout({
    layer,
    boxWidth: 40,
    boxHeight: 100,
    fontSize: 40,
    measure,
  });
  // Twelve one-character lines wrap out of a box that holds exactly two.
  expect(layout.lines).toHaveLength(2);
  expect(layout.totalLineCount).toBe(12);
});

it("centres the block vertically inside the box", () => {
  const layout = computeTextLayout({
    layer: base,
    boxWidth: 200,
    boxHeight: 300,
    fontSize: 40,
    measure,
  });
  const blockCentre = layout.startY + layout.blockHeight / 2 - layout.lineHeight / 2;
  expect(blockCentre).toBeCloseTo(150, 4);
});

it("caps a pill at the box width", () => {
  const layer = { ...base, style: "boxed" as const, text: "aaaaaaaaaaaaaaaaaaaa" };
  const layout = computeTextLayout({
    layer,
    boxWidth: 60,
    boxHeight: 300,
    fontSize: 40,
    measure,
  });
  expect(Math.max(...layout.pillWidths)).toBeLessThanOrEqual(60);
});

it("puts the draw point at the left inset for left alignment", () => {
  const layout = computeTextLayout({
    layer: { ...base, align: "left" },
    boxWidth: 200,
    boxHeight: 200,
    fontSize: 40,
    measure,
  });
  expect(layout.textX).toBeCloseTo(40 * 0.16, 6);
});

it("emits junction corners only for centred text", () => {
  const boxed = { ...base, style: "boxed" as const, text: "a\nbbbbb" };
  expect(
    computeTextLayout({
      layer: boxed,
      boxWidth: 400,
      boxHeight: 400,
      fontSize: 40,
      measure,
    }).junctions.length,
  ).toBeGreaterThan(0);
  expect(
    computeTextLayout({
      layer: { ...boxed, align: "left" },
      boxWidth: 400,
      boxHeight: 400,
      fontSize: 40,
      measure,
    }).junctions,
  ).toEqual([]);
});

it("scales every coordinate with the target scale", () => {
  // This is the guarantee the module exists for. The stage renderer and the
  // exporter differ only in the scale they pass, so the geometry must differ
  // only by that factor.
  const layer = { ...base, style: "boxed" as const, text: "one two three four five" };
  const stage = computeTextLayout({
    layer,
    boxWidth: 200,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  const exported = computeTextLayout({
    layer,
    boxWidth: 400,
    boxHeight: 800,
    fontSize: 80,
    measure: (line) => measure(line) * 2,
  });

  expect(exported.lines).toEqual(stage.lines);
  expect(exported.align).toBe(stage.align);
  expect(exported.perLineBox).toBe(stage.perLineBox);
  expect(exported.fullBox).toBe(stage.fullBox);
  expect(exported.pillVisible).toEqual(stage.pillVisible);
  expect(exported.totalLineCount).toBe(stage.totalLineCount);

  const scalars = [
    "fontSize",
    "lineHeight",
    "blockHeight",
    "contentHeight",
    "startY",
    "pillHeight",
    "textX",
    "horizontalPadding",
    "outlineWidth",
    "fullBoxRadius",
  ] as const;
  for (const key of scalars) {
    expect(exported[key], key).toBe(stage[key] * 2);
  }

  const vectors = ["lineCenters", "pillWidths", "pillStarts"] as const;
  for (const key of vectors) {
    expect(exported[key], key).toEqual(stage[key].map((value) => value * 2));
  }

  expect(exported.pillRadii).toEqual(
    stage.pillRadii.map((radii) => radii.map((r) => r * 2)),
  );
  expect(exported.junctions).toEqual(
    stage.junctions.map((corner) => ({
      ...corner,
      cx: corner.cx * 2,
      cy: corner.cy * 2,
      radius: corner.radius * 2,
    })),
  );
});

it("keeps one line of a single word too wide and too tall for the box", () => {
  const layer = { ...base, text: "unbreakablesupercalifragilistic" };
  const layout = computeTextLayout({
    layer,
    boxWidth: 60,
    boxHeight: 40,
    fontSize: 40,
    measure,
  });
  expect(layout.lines).toHaveLength(1);
  expect(layout.totalLineCount).toBe(8);
  expect(layout.blockHeight).toBeCloseTo(40 * TEXT_LINE_HEIGHT, 6);
});

it("keeps the empty lines of a run of newlines", () => {
  const layout = computeTextLayout({
    layer: { ...base, text: "\n\n\n" },
    boxWidth: 200,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  expect(layout.lines).toEqual(["", "", "", ""]);
  expect(layout.lineCenters).toHaveLength(4);
});

it("never lets a pill exceed the box width at any alignment", () => {
  for (const align of ["left", "center", "right"] as const) {
    const layer = { ...base, align, style: "boxed" as const, text: "aaaa bbbb cccc" };
    const layout = computeTextLayout({
      layer,
      boxWidth: 80,
      boxHeight: 400,
      fontSize: 40,
      measure,
    });
    for (const [index, width] of layout.pillWidths.entries()) {
      expect(width, align).toBeLessThanOrEqual(80);
      expect(layout.pillStarts[index]!, align).toBeGreaterThanOrEqual(0);
      expect(layout.pillStarts[index]! + width, align).toBeLessThanOrEqual(80);
    }
  }
});

it("draws no pill on an empty line", () => {
  const layout = computeTextLayout({
    layer: { ...base, style: "boxed" as const, text: "one\n\ntwo" },
    boxWidth: 400,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  expect(layout.pillVisible).toEqual([true, false, true]);
});

it("puts the draw point at the right inset for right alignment", () => {
  const layout = computeTextLayout({
    layer: { ...base, align: "right" },
    boxWidth: 200,
    boxHeight: 200,
    fontSize: 40,
    measure,
  });
  expect(layout.textX).toBeCloseTo(200 - 40 * 0.16, 6);
});

it("reports the full-box background and its radius", () => {
  const layer = { ...base, style: "boxed" as const, backgroundShape: "full" as const };
  const layout = computeTextLayout({
    layer,
    boxWidth: 200,
    boxHeight: 300,
    fontSize: 40,
    measure,
  });
  expect(layout.fullBox).toBe(true);
  expect(layout.fullBoxRadius).toBeCloseTo(40 * 0.18, 6);
  expect(
    computeTextLayout({
      layer: base,
      boxWidth: 200,
      boxHeight: 300,
      fontSize: 40,
      measure,
    }).fullBox,
  ).toBe(false);
});

it("clamps the full-box radius to the smaller half of the box", () => {
  const layer = { ...base, style: "boxed" as const, backgroundShape: "full" as const };
  const layout = computeTextLayout({
    layer,
    boxWidth: 8,
    boxHeight: 300,
    fontSize: 40,
    measure,
  });
  expect(layout.fullBoxRadius).toBe(4);
});

it("adds the horizontal padding to a pill only for a per-line box", () => {
  const plain = computeTextLayout({
    layer: { ...base, text: "ab" },
    boxWidth: 400,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  const boxed = computeTextLayout({
    layer: { ...base, style: "boxed" as const, text: "ab" },
    boxWidth: 400,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  expect(plain.pillWidths[0]).toBeCloseTo(20, 6);
  expect(boxed.pillWidths[0]).toBeCloseTo(20 + 40 * 0.52 * 2, 6);
});

it("always keeps one line even when the box is shorter than a line", () => {
  const layout = computeTextLayout({
    layer: { ...base, text: "one two three four five" },
    boxWidth: 200,
    boxHeight: 1,
    fontSize: 40,
    measure,
  });
  expect(layout.lines).toHaveLength(1);
});

it("maps each alignment onto a distinct pill position", () => {
  const boxed = { ...base, style: "boxed" as const, text: "a\nbbbbb" };
  const at = (align: "left" | "center" | "right") =>
    computeTextLayout({
      layer: { ...boxed, align },
      boxWidth: 400,
      boxHeight: 400,
      fontSize: 40,
      measure,
    });

  const left = at("left");
  expect(left.pillStarts).toEqual([0, 0]);

  const right = at("right");
  for (const [index, start] of right.pillStarts.entries()) {
    expect(start + right.pillWidths[index]!).toBeCloseTo(400, 6);
  }

  // Centred pills share an axis, which is what makes the junction notches meet.
  const centre = at("center");
  for (const [index, start] of centre.pillStarts.entries()) {
    expect(start + centre.pillWidths[index]! / 2).toBeCloseTo(200, 6);
  }

  // The two narrow lines must actually sit in three different places, or the
  // assertions above would all pass on a hardcoded centre.
  expect(
    new Set([left.pillStarts[0], centre.pillStarts[0], right.pillStarts[0]]).size,
  ).toBe(3);
});

it("keeps pill geometry proportional below the font size where the old floors bit", () => {
  // Adjacent pills here differ by 1.7 stage pixels, inside the window where
  // app.js's absolute floors of 2px and 1px disagreed with the proportional
  // thresholds. With either floor restored the stage rounds a corner the export
  // leaves square, and drops a notch the export keeps, so this test goes red.
  const layer = { ...base, style: "boxed" as const, text: "ab\nc" };
  const fine = (line: string) => line.length * 1.7;
  const stage = computeTextLayout({
    layer,
    boxWidth: 100,
    boxHeight: 200,
    fontSize: 24,
    measure: fine,
  });
  const exported = computeTextLayout({
    layer,
    boxWidth: 200,
    boxHeight: 400,
    fontSize: 48,
    measure: (line) => fine(line) * 2,
  });

  expect(stage.pillRadii[0]).toEqual([6.48, 6.48, 6.48, 6.48]);
  expect(stage.junctions).toHaveLength(2);
  expect(exported.pillRadii).toEqual(
    stage.pillRadii.map((radii) => radii.map((r) => r * 2)),
  );
  expect(exported.junctions).toEqual(
    stage.junctions.map((corner) => ({
      ...corner,
      cx: corner.cx * 2,
      cy: corner.cy * 2,
      radius: corner.radius * 2,
    })),
  );
});

it("reserves the wrap inset before wrapping", () => {
  // Nine characters measure 90 and the box is 100 wide, so the line fits only
  // if the inset of 0.32 font sizes is not reserved.
  const layout = computeTextLayout({
    layer: { ...base, text: "aaaaaaaaa" },
    boxWidth: 100,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  expect(layout.lines).toEqual(["aaaaaaaa", "a"]);
});

it("reserves the vertical padding before counting the lines that fit", () => {
  // Two lines of 44.8 need 89.6, which fits 92 outright and does not fit once
  // the padding of 0.1 font sizes is reserved at both edges.
  const layout = computeTextLayout({
    layer: { ...base, text: "one two three four five" },
    boxWidth: 200,
    boxHeight: 92,
    fontSize: 40,
    measure,
  });
  expect(layout.lines).toHaveLength(1);
  expect(layout.totalLineCount).toBe(2);
});

it("reports the height the box would need to show every line", () => {
  const layout = computeTextLayout({
    layer: { ...base, text: "one two three four five" },
    boxWidth: 200,
    boxHeight: 92,
    fontSize: 40,
    measure,
  });
  // Two lines plus the padding at both edges, which is what ensureTextFits
  // grows the box to today by reading scrollHeight.
  expect(layout.contentHeight).toBeCloseTo(2 * 40 * TEXT_LINE_HEIGHT + 8, 6);
  expect(layout.contentHeight).toBeGreaterThan(92);
});

it("reports no overflow when every line fits", () => {
  const layout = computeTextLayout({
    layer: base,
    boxWidth: 200,
    boxHeight: 300,
    fontSize: 40,
    measure,
  });
  expect(layout.totalLineCount).toBe(layout.lines.length);
  expect(layout.contentHeight).toBeLessThanOrEqual(300);
});

it("clamps a pill's corner radii to its own half width", () => {
  const layout = computeTextLayout({
    layer: { ...base, style: "boxed" as const, text: "a" },
    boxWidth: 14,
    boxHeight: 400,
    fontSize: 40,
    measure,
  });
  // The pill is capped at the 14px box, so its 10.8px radius would overlap
  // itself. Both draw paths clamp at this point, so the module does it here.
  expect(layout.pillWidths).toEqual([14]);
  expect(layout.pillRadii[0]).toEqual([7, 7, 7, 7]);
});

it("reports a single line that is taller than its box as overflowing", () => {
  // The one-line floor means totalLineCount cannot signal this case, which is
  // why contentHeight is the overflow test and totalLineCount is not.
  const layout = computeTextLayout({
    layer: base,
    boxWidth: 200,
    boxHeight: 30,
    fontSize: 40,
    measure,
  });
  expect(layout.totalLineCount).toBe(layout.lines.length);
  expect(layout.contentHeight).toBeGreaterThan(30);
});

it("scales the authored font size onto the render surface", () => {
  // app.js:2724, app.js:2737 and app.js:4439 all wrote this expression by hand.
  expect(fontSizeAt(base, 1080)).toBe(40);
  expect(fontSizeAt(base, 540)).toBe(20);
  expect(fontSizeAt({ ...base, size: 48 }, 450)).toBeCloseTo(20, 6);
});
