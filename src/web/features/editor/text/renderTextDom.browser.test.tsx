import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import "../../../design/fonts.css";
import { textColorOf } from "@shared/geometry/index.js";
import type { Project, TextLayer } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import {
  LayerHarness,
  editorStore,
  libraryFor,
  measuredStage,
} from "../layers/testing.js";

/*
 * The pill ribbon, measured on what the browser actually filled.
 *
 * Every assertion below goes through `isPointInFill` on the rendered path and
 * through the paths' own bounding boxes. Nothing here calls `roundedRectPath`
 * or `concaveCornerPath`, and nothing recomputes a `TextLayout`.
 *
 * That is the whole point of the file. An earlier check compared the emitted
 * `d` attribute against `roundedRectPath(...)` — the function that produced it
 * — so it pinned the hand-off from layout to renderer and not the drawing.
 * Squaring a corner inside `roundedRectPath` changed both sides of that
 * comparison equally and left the suite green.
 */

/** Within a pixel of a corner: inside a squared one, outside any real radius. */
const CORNER_PROBE = 1;

function boxedProject(options: {
  text: string;
  align?: "left" | "center" | "right";
}): Project {
  const project = fixtureProject({ texts: 1, overlays: 0 });
  const text = project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text layer.");
  text.text = options.text;
  text.style = "boxed";
  text.backgroundShape = "lines";
  text.background = "#FFFFFF";
  text.align = options.align ?? "center";
  text.x = 0.05;
  text.y = 0.25;
  text.width = 0.9;
  text.height = 0.3;
  text.size = 90;
  return project;
}

async function draw(project: Project) {
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  await measuredStage();
  const svg = document.querySelector<SVGSVGElement>(
    '[data-testid="text-inside"] [data-testid="text-pills"]',
  );
  if (svg === null) throw new Error("The boxed text drew no pill background.");
  return {
    pills: [...svg.querySelectorAll<SVGPathElement>("[data-pill]")],
    notches: [...svg.querySelectorAll<SVGPathElement>("[data-junction]")],
  };
}

function filled(path: SVGPathElement, x: number, y: number): boolean {
  return path.isPointInFill(new DOMPoint(x, y));
}

/**
 * How deep the fill is cut back from a corner, along its diagonal.
 *
 * Zero for a square corner. For a radius r it is r(1 - 1/√2), so any answer
 * above a pixel means a corner that was actually drawn round, whatever path
 * string produced it.
 */
function cornerCutDepth(
  path: SVGPathElement,
  cornerX: number,
  cornerY: number,
  towardX: number,
  towardY: number,
): number {
  for (let depth = 0; depth <= 40; depth += 0.25) {
    if (filled(path, cornerX + towardX * depth, cornerY + towardY * depth)) {
      return depth;
    }
  }
  return Infinity;
}

it("draws every pill's corners round, and its body solid", async () => {
  const { pills } = await draw(boxedProject({ text: "Alone" }));
  expect(pills).toHaveLength(1);
  const pill = pills[0];
  if (pill === undefined) throw new Error("No pill.");
  const box = pill.getBBox();

  // The body is filled, so a cut corner below is a corner and not a missing pill.
  expect(filled(pill, box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
  expect(filled(pill, box.x + box.width / 2, box.y + CORNER_PROBE)).toBe(true);

  /*
   * All four corners, separately. A single pill is the only shape whose four
   * radii are all non-zero: lineCornerRadii squares off any edge a neighbouring
   * pill already covers, so a middle line legitimately has square corners.
   */
  const corners: [string, number, number, number, number][] = [
    ["top left", box.x, box.y, 1, 1],
    ["top right", box.x + box.width, box.y, -1, 1],
    ["bottom right", box.x + box.width, box.y + box.height, -1, -1],
    ["bottom left", box.x, box.y + box.height, 1, -1],
  ];
  for (const [name, x, y, towardX, towardY] of corners) {
    expect(
      filled(pill, x + towardX * CORNER_PROBE, y + towardY * CORNER_PROBE),
      name,
    ).toBe(false);
    const depth = cornerCutDepth(pill, x, y, towardX, towardY);
    expect(depth, `${name} is cut back`).toBeGreaterThan(CORNER_PROBE);
    expect(depth, `${name} is a corner rather than a gap`).toBeLessThan(box.height / 2);
  }
});

it("fills the notch where a narrow line meets a wide one", async () => {
  const { pills, notches } = await draw(
    boxedProject({ text: "Wide middle line here\nEnd" }),
  );
  expect(pills).toHaveLength(2);
  // Two per boundary, one for each side of the centred stack.
  expect(notches).toHaveLength(2);

  const first = pills[0]?.getBBox();
  const second = pills[1]?.getBBox();
  if (first === undefined || second === undefined) throw new Error("No pills.");
  expect(second.width, "the second line is the narrow one").toBeLessThan(first.width);

  /*
   * The two concave corners, read off the rendered boxes rather than off any
   * layout: where the wide pill's bottom edge meets each side of the narrow
   * pill below it. Without a notch this is a visible nick in the ribbon.
   */
  const boundaryY = first.y + first.height;
  const corners: [string, number, number][] = [
    ["left", second.x, -1],
    ["right", second.x + second.width, 1],
  ];

  for (const [name, cornerX, outward] of corners) {
    const x = cornerX + outward * CORNER_PROBE;
    const y = boundaryY + CORNER_PROBE;
    // Outside both pills: this sliver is the notch's alone to fill.
    expect(
      pills.some((pill) => filled(pill, x, y)),
      `${name} is outside the pills`,
    ).toBe(false);
    expect(
      notches.some((notch) => filled(notch, x, y)),
      `${name} notch fills it`,
    ).toBe(true);
  }
});

it("cuts no notch into a stack that meets on a flat edge", async () => {
  const { pills, notches } = await draw(
    boxedProject({ text: "Wide middle line here\nEnd", align: "left" }),
  );

  // app.js:2846 and layout.ts:186. Left and right aligned pills share a flat
  // edge, so there is no concave corner to fill and none is drawn.
  expect(pills).toHaveLength(2);
  expect(notches).toHaveLength(0);
});

/*
 * The weight/slant/rules paths, below.
 *
 * This file has no fixtureText() helper, so each layer is built straight from
 * fixtureProject() (src/web/features/editor/testing.ts), the way
 * useTextLayout.browser.test.tsx does.
 */

function styledProject(overrides: Partial<TextLayer>): Project {
  const project = fixtureProject({ texts: 1, overlays: 0 });
  const text = project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text layer.");
  Object.assign(text, overrides);
  return project;
}

async function drawStyled(project: Project): Promise<void> {
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  await measuredStage();
}

it("paints the block at the layer's own weight and slant", async () => {
  await drawStyled(styledProject({ weight: 700, italic: true }));
  const block = document.querySelector<HTMLElement>('[data-testid="text-block"]');
  expect(block?.style.fontWeight).toBe("700");
  expect(block?.style.fontStyle).toBe("italic");
});

it("draws one underline rule per non-empty line", async () => {
  await drawStyled(styledProject({ text: "one\n\ntwo", underline: true }));
  expect(document.querySelectorAll("[data-underline]").length).toBe(2);
});

it("draws no rule when the layer asks for none", async () => {
  await drawStyled(styledProject({}));
  expect(document.querySelectorAll("[data-underline]").length).toBe(0);
  expect(document.querySelectorAll("[data-strikethrough]").length).toBe(0);
});

it("draws both rules when the layer asks for both", async () => {
  const project = styledProject({ text: "one", underline: true, strikethrough: true });
  await drawStyled(project);
  const underline = document.querySelector("[data-underline]");
  const strikethrough = document.querySelector("[data-strikethrough]");
  expect(document.querySelectorAll("[data-underline]").length).toBe(1);
  expect(document.querySelectorAll("[data-strikethrough]").length).toBe(1);

  // Counting the rects says nothing about where they land. The underline
  // sits below the line's centre, the strike above it, both span the same
  // width, and both take the glyphs' own colour.
  const y = (rect: Element | null) => Number(rect?.getAttribute("y"));
  const width = (rect: Element | null) => Number(rect?.getAttribute("width"));
  expect(y(underline)).toBeGreaterThan(y(strikethrough));
  expect(width(underline)).toBeGreaterThan(0);
  expect(width(underline)).toBe(width(strikethrough));
  const layer = project.slides[0]!.texts[0]!;
  expect(underline?.getAttribute("fill")).toBe(textColorOf(layer));
});

it("strokes a rule on outline text the way it strokes a glyph", async () => {
  const project = styledProject({ text: "one", underline: true, style: "outline" });
  await drawStyled(project);
  const underline = document.querySelector("[data-underline]");
  const glyph = document.querySelector('[data-testid="text-block"] text');
  expect(underline?.getAttribute("stroke")).toBe(glyph?.getAttribute("stroke"));
  expect(underline?.getAttribute("stroke-width")).toBe(
    glyph?.getAttribute("stroke-width"),
  );
});
