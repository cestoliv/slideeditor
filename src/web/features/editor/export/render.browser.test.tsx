import { afterEach, describe, expect, it } from "vitest";
// The font wait below asks for the real face, so the test loads the same
// @font-face declaration the app does.
import "../../../design/fonts.css";
import { outputHeight } from "@shared/geometry/index.js";
import { textFontString } from "@shared/text/index.js";
import type { LibraryItem } from "@shared/schema/index.js";
import { renderSlideBlob, renderSlideCanvas } from "./render.js";
import {
  gradientImage,
  layoutAt,
  paintedImage,
  libraryItem,
  nearestName,
  pixelAt,
  quadrantImage,
  sameColor,
  slideFixture,
  solidImage,
} from "./testing.js";
import type { Rgba } from "./testing.js";

/*
 * The canvas renderer, checked by reading its own pixels back.
 *
 * The file is named .browser.test.tsx rather than the brief's .browser.test.ts
 * on purpose. vitest.config.ts gives the web project
 * `include: ["src/web/**\/*.browser.test.tsx"]`, and the shared project takes
 * `src/web/features/editor/**\/*.test.ts`, so a .ts here would run under node
 * with no canvas at all.
 */

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const YELLOW: Rgba = [255, 255, 0, 255];
const BLACK: Rgba = [17, 17, 17, 255];
const GREY: Rgba = [128, 128, 128, 255];
const PALETTE = { red: RED, green: GREEN, blue: BLUE, yellow: YELLOW, ink: BLACK };

const GREY_BACKGROUND = solidImage(1080, 1920, "#808080");

function assets(...items: LibraryItem[]): Map<string, LibraryItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function backgroundOnly(): Map<string, LibraryItem> {
  return assets(libraryItem("background", GREY_BACKGROUND, 1080, 1920));
}

function textSeed(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "text-1",
    text: "Hello",
    x: 0.1,
    y: 0.4,
    width: 0.8,
    height: 0.2,
    size: 90,
    style: "plain",
    outlineWidth: 12,
    color: "#FFFFFF",
    background: "white",
    backgroundShape: "full",
    align: "center",
    rotation: 0,
    z: 2,
    ...overrides,
  };
}

function overlaySeed(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "overlay-1",
    itemId: "square",
    x: 0.1,
    y: 0.1,
    width: 0.4,
    height: 0.2,
    rotation: 0,
    cropX: 0,
    cropY: 0,
    cropW: 1,
    cropH: 1,
    z: 1,
    ...overrides,
  };
}

describe("renderSlideCanvas", () => {
  it("renders at 1080 wide and the ratio's height", async () => {
    const canvas = await renderSlideCanvas(slideFixture(), {
      height: 1920,
      assets: backgroundOnly(),
    });
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1920);
  });

  it("renders every offered ratio at its own output height", async () => {
    for (const ratio of [
      { w: 3, h: 4 },
      { w: 1, h: 1 },
      { w: 1.91, h: 1 },
    ]) {
      const height = outputHeight(ratio);
      const canvas = await renderSlideCanvas(slideFixture(), {
        height,
        assets: backgroundOnly(),
      });
      expect(canvas.width).toBe(1080);
      expect(canvas.height).toBe(height);
    }
  });

  it("renders at the width the caller asks for, which the rail's thumbnail does", async () => {
    const canvas = await renderSlideCanvas(slideFixture(), {
      width: 540,
      height: 960,
      assets: backgroundOnly(),
    });
    expect(canvas.width).toBe(540);
    expect(canvas.height).toBe(960);
  });

  it("covers the whole canvas with the background photo", async () => {
    const canvas = await renderSlideCanvas(slideFixture(), {
      height: 1920,
      assets: backgroundOnly(),
    });
    for (const [x, y] of [
      [2, 2],
      [1077, 2],
      [2, 1917],
      [1077, 1917],
      [540, 960],
    ]) {
      expect(
        sameColor(pixelAt(canvas, x ?? 0, y ?? 0), GREY),
        `the photo reaches ${String(x)},${String(y)}`,
      ).toBe(true);
    }
  });

  it("draws layers in z order, overlays and texts interleaved", async () => {
    // Three layers stacked over one point: a red overlay, a black boxed text,
    // and a green overlay. Only the z values change between the renders.
    const items = assets(
      libraryItem("background", GREY_BACKGROUND, 1080, 1920),
      libraryItem("red", solidImage(64, 64, "#ff0000"), 64, 64),
      libraryItem("green", solidImage(64, 64, "#00ff00"), 64, 64),
    );
    // Inside all three layers and clear of the glyphs, which sit on the centre
    // line at y 960 and would blend the probe against the pill behind them.
    const probe: [number, number] = [250, 800];

    const build = (redZ: number, textZ: number, greenZ: number) =>
      slideFixture({
        overlays: [
          overlaySeed({
            id: "red",
            itemId: "red",
            x: 0.2,
            y: 0.4,
            width: 0.6,
            height: 0.2,
            z: redZ,
          }),
          overlaySeed({
            id: "green",
            itemId: "green",
            x: 0.2,
            y: 0.4,
            width: 0.6,
            height: 0.2,
            z: greenZ,
          }),
        ],
        texts: [
          textSeed({
            text: "Stack",
            x: 0.2,
            y: 0.4,
            width: 0.6,
            height: 0.2,
            style: "boxed",
            backgroundShape: "full",
            background: "black",
            z: textZ,
          }),
        ],
      });

    const top = async (redZ: number, textZ: number, greenZ: number) => {
      const canvas = await renderSlideCanvas(build(redZ, textZ, greenZ), {
        height: 1920,
        assets: items,
      });
      return nearestName(pixelAt(canvas, probe[0], probe[1]), PALETTE);
    };

    expect(await top(1, 2, 3), "the highest z wins").toBe("green");
    expect(await top(1, 3, 2), "a text draws over an overlay below it").toBe("ink");
    expect(await top(3, 2, 1), "an overlay draws over a text below it").toBe("red");
  });

  it("applies an overlay's crop and rotation", async () => {
    const items = assets(
      libraryItem("background", GREY_BACKGROUND, 1080, 1920),
      libraryItem("square", quadrantImage(200), 200, 200),
    );
    // The overlay covers x 108..540 and y 192..576 of the canvas.
    const box = { x: 0.1, y: 0.1, width: 0.4, height: 0.2 };
    const corners = {
      topLeft: [140, 230],
      topRight: [508, 230],
      bottomLeft: [140, 538],
      bottomRight: [508, 538],
    } as const;

    const upright = await renderSlideCanvas(
      slideFixture({ overlays: [overlaySeed({ ...box })] }),
      { height: 1920, assets: items },
    );
    expect(nearestName(pixelAt(upright, ...corners.topLeft), PALETTE)).toBe("red");
    expect(nearestName(pixelAt(upright, ...corners.topRight), PALETTE)).toBe("green");
    expect(nearestName(pixelAt(upright, ...corners.bottomLeft), PALETTE)).toBe("blue");
    expect(nearestName(pixelAt(upright, ...corners.bottomRight), PALETTE)).toBe("yellow");

    // Half a turn about the overlay's own centre swaps both axes.
    const turned = await renderSlideCanvas(
      slideFixture({ overlays: [overlaySeed({ ...box, rotation: 180 })] }),
      { height: 1920, assets: items },
    );
    expect(nearestName(pixelAt(turned, ...corners.topLeft), PALETTE)).toBe("yellow");
    expect(nearestName(pixelAt(turned, ...corners.bottomRight), PALETTE)).toBe("red");

    // The right half of the source fills the whole box once it is cropped to it.
    const cropped = await renderSlideCanvas(
      slideFixture({ overlays: [overlaySeed({ ...box, cropX: 0.5, cropW: 0.5 })] }),
      { height: 1920, assets: items },
    );
    expect(nearestName(pixelAt(cropped, ...corners.topLeft), PALETTE)).toBe("green");
    expect(nearestName(pixelAt(cropped, ...corners.topRight), PALETTE)).toBe("green");
    expect(nearestName(pixelAt(cropped, ...corners.bottomLeft), PALETTE)).toBe("yellow");
    expect(nearestName(pixelAt(cropped, ...corners.bottomRight), PALETTE)).toBe("yellow");
  });

  it("clips a plain text to its own box, the way the stage does", async () => {
    // One line taller than its box. computeTextLayout keeps the line rather
    // than drawing nothing, so the glyphs overhang, and text.module.css hides
    // that overhang with overflow:hidden on the plain style alone.
    const slide = slideFixture({
      texts: [
        textSeed({
          text: "Ijgy",
          x: 0.1,
          y: 0.45,
          width: 0.8,
          height: 0.02,
          size: 160,
          color: "#FFFFFF",
        }),
      ],
    });
    const canvas = await renderSlideCanvas(slide, {
      height: 1920,
      assets: backgroundOnly(),
    });
    // The box runs y 864..902. Inside it the glyphs paint white over the grey.
    const inside = Array.from({ length: 1080 }, (_column, x) =>
      pixelAt(canvas, x, 883),
    ).filter((pixel) => pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200).length;
    expect(inside, "the glyphs paint inside the box").toBeGreaterThan(0);

    for (const y of [840, 860, 910, 940]) {
      const outside = Array.from({ length: 1080 }, (_column, x) =>
        pixelAt(canvas, x, y),
      ).filter((pixel) => !sameColor(pixel, GREY, 24)).length;
      expect(outside, `nothing paints at y ${String(y)}, outside the box`).toBe(0);
    }
  });

  it("rounds each pill by the radius the layout returned", async () => {
    /*
     * The one class of fault neither pill.test.ts nor the parity test can see.
     * Squaring a pill's corners here is a renderer fault, so pill.test.ts never
     * loads the code that commits it; and a corner covers a few dozen pixels of
     * a slide, so no whole-frame count resolves one at any threshold (measured:
     * forcing a pill's radii to zero moves the parity figure from 0.00476 to
     * 0.00478). A probe does resolve it, because a probe looks where the fault is.
     *
     * The middle pill is the widest, so no neighbour covers its corners and
     * lineCornerRadii rounds all four. Its DOM counterpart is asserted in
     * parity.browser.test.tsx.
     */
    const slide = slideFixture({
      texts: [
        textSeed({
          text: "Hi\nWider line\nEnd",
          style: "boxed",
          backgroundShape: "lines",
          background: "black",
          color: "#FFFFFF",
          x: 0.05,
          y: 0.3,
          width: 0.9,
          height: 0.3,
          size: 110,
        }),
      ],
    });
    const layer = slide.texts[0];
    if (layer === undefined) throw new Error("The fixture holds no text layer.");
    const layout = layoutAt(layer, 1080, 1920);
    expect(layout.lines, "the fixture wraps to the three lines it is written as").toEqual(
      ["Hi", "Wider line", "End"],
    );

    const boxX = layer.x * 1080;
    const boxY = layer.y * 1920;
    const index = 1;
    const radius = layout.pillRadii[index]?.[0] ?? 0;
    expect(radius, "the middle pill is rounded at all").toBeGreaterThan(20);
    const left = boxX + (layout.pillStarts[index] ?? 0);
    const right = left + (layout.pillWidths[index] ?? 0);
    const top = boxY + (layout.lineCenters[index] ?? 0) - layout.pillHeight / 2;
    const bottom = top + layout.pillHeight;

    const canvas = await renderSlideCanvas(slide, {
      height: 1920,
      assets: backgroundOnly(),
    });

    /*
     * A point on the diagonal at offset t from the corner falls outside the
     * rounded pill exactly when t < r(1 - 1/sqrt2), which is 0.293r. These sit
     * at 0.15r, comfortably inside that, and a squared corner paints every one.
     */
    const near = radius * 0.15;
    for (const [x, y] of [
      [left + near, top + near],
      [right - near, top + near],
      [left + near, bottom - near],
      [right - near, bottom - near],
    ]) {
      expect(
        sameColor(pixelAt(canvas, x ?? 0, y ?? 0), GREY, 24),
        `the corner at ${String(x)},${String(y)} is cut away`,
      ).toBe(true);
    }

    /*
     * The radius itself, measured rather than bracketed.
     *
     * Two pixels below the pill's top edge, the corner arc meets that row at
     * r - sqrt(2rd - d^2) from the pill's left edge. Scanning for the first
     * painted pixel on that row reads the radius the renderer actually used,
     * which a bracket cannot: probes on the diagonal alone accept a radius
     * twice the layout's, because doubling it moves both of them into the
     * interior. Measured, 29.7 gives 19.0, half of it gives 7.4 and twice it
     * gives 44.1, so three pixels of slack separates all three.
     */
    const depth = 2;
    const expectedInset = radius - Math.sqrt(2 * radius * depth - depth * depth);
    let measuredInset = -1;
    for (let step = 0; step < radius * 3; step += 1) {
      if (sameColor(pixelAt(canvas, left + step, top + depth), BLACK, 24)) {
        measuredInset = step;
        break;
      }
    }
    expect(
      measuredInset,
      "the top left corner's arc is on that row at all",
    ).toBeGreaterThan(0);
    expect(measuredInset).toBeCloseTo(expectedInset, -0.5);

    // The straight edge between the corners, so the probes above differ because
    // of the rounding rather than because the pill is not there.
    expect(
      sameColor(pixelAt(canvas, left + 3, (top + bottom) / 2), BLACK, 24),
      "the pill reaches its own left edge between the corners",
    ).toBe(true);
  });

  it("draws an outline text's stroke around its fill", async () => {
    const slide = slideFixture({
      texts: [
        textSeed({
          text: "O",
          style: "outline",
          color: "#FFFFFF",
          size: 200,
          x: 0.2,
          y: 0.4,
          width: 0.6,
          height: 0.2,
        }),
      ],
    });
    const canvas = await renderSlideCanvas(slide, {
      height: 1920,
      assets: backgroundOnly(),
    });
    const column = Array.from({ length: 1920 }, (_row, y) => pixelAt(canvas, 540, y));
    // outlineColorFor("#FFFFFF") is #111111, so a white glyph carries a dark ring.
    expect(column.some((pixel) => sameColor(pixel, [255, 255, 255, 255], 20))).toBe(true);
    expect(column.some((pixel) => sameColor(pixel, BLACK, 20))).toBe(true);
  });

  it("fills the concave notch between two pills of different widths", async () => {
    /*
     * The junctions, which were the last part of the ribbon with no probe on
     * either side, and the part that mattered most: the junction floor bit
     * below a 55.56 pixel font where the corner floor bit below 37, so these
     * drifted more often than the corners did. Replacing the notch loop with a
     * no-op left every other test in this directory green.
     *
     * A notch is the square between two pills minus a quarter disc, which is
     * what turns a stack of rectangles into one continuous shape. Two probes on
     * the diagonal settle it. A point at offset t from the corner is inside the
     * notch when t < r(1 - 1/sqrt2), which is 0.293r, and inside the disc it
     * cuts away above that. So 0.15r must be painted and 0.6r must not, and the
     * pair pins the concave shape rather than only its presence: a notch drawn
     * as a plain filled square would paint both.
     *
     * Neither point is inside either pill. The narrow pill's edge is what cx
     * names, and the wide pill's edge is what cy names, so both probes sit
     * outside the two rectangles and only the notch can paint them.
     */
    const slide = slideFixture({
      texts: [
        textSeed({
          // Narrow, wide, narrow, so one boundary faces up and the other down
          // and all four quadrants of lineJunctionCorners are drawn.
          text: "I\nMMMM\nI",
          style: "boxed",
          backgroundShape: "lines",
          background: "black",
          color: "#FFFFFF",
          align: "center",
          x: 0.05,
          y: 0.25,
          width: 0.9,
          height: 0.4,
          size: 200,
        }),
      ],
    });
    const layer = slide.texts[0];
    if (layer === undefined) throw new Error("The fixture holds no text layer.");
    const layout = layoutAt(layer, 1080, 1920);
    expect(layout.lines, "the fixture wraps to the three lines it is written as").toEqual(
      ["I", "MMMM", "I"],
    );
    expect(
      layout.junctions.map((corner) => corner.quadrant),
      "a narrow pill over a wide one and a wide one over a narrow one",
    ).toEqual(["upper-left", "upper-right", "lower-left", "lower-right"]);

    const boxX = layer.x * 1080;
    const boxY = layer.y * 1920;
    const canvas = await renderSlideCanvas(slide, {
      height: 1920,
      assets: backgroundOnly(),
    });

    for (const corner of layout.junctions) {
      const towardsLeft = corner.quadrant.endsWith("left");
      const towardsTop = corner.quadrant.startsWith("upper");
      const at = (offset: number): [number, number] => [
        boxX + corner.cx + (towardsLeft ? -offset : offset),
        boxY + corner.cy + (towardsTop ? -offset : offset),
      ];

      const inside = at(corner.radius * 0.15);
      expect(
        sameColor(pixelAt(canvas, inside[0], inside[1]), BLACK, 24),
        `the ${corner.quadrant} notch is filled at ${inside.map(Math.round).join()}`,
      ).toBe(true);

      const beyond = at(corner.radius * 0.6);
      expect(
        sameColor(pixelAt(canvas, beyond[0], beyond[1]), GREY, 24),
        `the ${corner.quadrant} notch is cut back by its arc at ${beyond
          .map(Math.round)
          .join()}`,
      ).toBe(true);
    }
  });

  it("crops a tiny asset by its fraction, with no pixel floor", async () => {
    /*
     * The last absolute pixel constant this renderer carried. app.js:4421-4422
     * floored the source rectangle at one pixel, and OverlayLayer sizes its
     * <img> at 100 / crop.w per cent with no such floor, so on an asset small
     * enough for the floor to bite the stage and the export framed different
     * parts of the picture.
     *
     * Probing a colour cannot show this, because drawImage interpolates a
     * fractional source rectangle and every probe comes back a blend. What does
     * show it is the floor's own signature: it makes two crops that differ only
     * below one source pixel collapse onto the same window and render
     * identically. Four pixels wide, so a fifth of a pixel is a fifth of the
     * source.
     */
    const gradient = paintedImage(4, 1, (context) => {
      const wash = context.createLinearGradient(0, 0, 4, 0);
      wash.addColorStop(0, "#000000");
      wash.addColorStop(1, "#ffffff");
      context.fillStyle = wash;
      context.fillRect(0, 0, 4, 1);
    });
    const items = assets(
      libraryItem("background", GREY_BACKGROUND, 1080, 1920),
      libraryItem("narrow", gradient, 4, 1),
    );

    const renderCrop = async (cropW: number) => {
      const slide = slideFixture({
        overlays: [
          overlaySeed({
            itemId: "narrow",
            x: 0.2,
            y: 0.2,
            width: 0.4,
            height: 0.2,
            cropX: 0.25,
            cropW,
          }),
        ],
      });
      const canvas = await renderSlideCanvas(slide, { height: 1920, assets: items });
      // The overlay covers x 216..648, and the source is a horizontal wash, so
      // its right edge is where two source windows differ most.
      return pixelAt(canvas, 640, 576);
    };

    // 0.2 and 0.96 of a source pixel. Both are under the deleted floor, which
    // would have widened each to a whole one and made these two equal.
    const narrow = await renderCrop(0.05);
    const wide = await renderCrop(0.24);
    expect(narrow[3], "the narrow crop painted something").toBe(255);
    expect(wide[3], "the wide crop painted something").toBe(255);
    expect(
      sameColor(narrow, wide, 12),
      "two crops a fraction of a source pixel apart must not render the same",
    ).toBe(false);
  });

  it("leaves a layer out when the library has no asset for it", async () => {
    const slide = slideFixture({
      overlays: [overlaySeed({ itemId: "missing" })],
    });
    const canvas = await renderSlideCanvas(slide, {
      height: 1920,
      assets: backgroundOnly(),
    });
    expect(sameColor(pixelAt(canvas, 300, 300), GREY)).toBe(true);
  });

  it("renders a slide whose background the library has lost", async () => {
    const slide = slideFixture({ backgroundItemId: "gone" });
    const canvas = await renderSlideCanvas(slide, { height: 1920, assets: new Map() });
    expect(canvas.width).toBe(1080);
    expect(pixelAt(canvas, 540, 960)[3], "nothing is painted, so nothing is opaque").toBe(
      0,
    );
  });
});

describe("the font wait", () => {
  const realLoad = document.fonts.load.bind(document.fonts);
  const realMeasure = CanvasRenderingContext2D.prototype.measureText;

  afterEach(() => {
    Reflect.deleteProperty(document.fonts, "load");
    CanvasRenderingContext2D.prototype.measureText = realMeasure;
  });

  it("waits for the font before measuring text", async () => {
    /*
     * drawTextLayer in app.js:4449 set context.font to TikTok Sans and measured
     * straight away, so the first export after a cold load wrapped its lines
     * against whichever fallback face the browser had. renderSlideCanvas awaits
     * document.fonts.load first.
     *
     * The gate below is what makes this an ordering test rather than a race.
     * The render cannot pass the font wait until the test releases it, so
     * `order` records what the renderer did while it was held.
     */
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    document.fonts.load = async (font: string, text?: string) => {
      order.push(`load:${font}`);
      await gate;
      return realLoad(font, text);
    };
    CanvasRenderingContext2D.prototype.measureText = function measureText(
      this: CanvasRenderingContext2D,
      text: string,
    ) {
      order.push("measure");
      return realMeasure.call(this, text);
    };

    const rendering = renderSlideCanvas(
      slideFixture({ texts: [textSeed({ text: "Measure me twice" })] }),
      { height: 1920, assets: backgroundOnly() },
    );

    /*
     * Loading an image here takes the render's own next asynchronous step. Had
     * the renderer not awaited the font, it would have decoded its background
     * and measured its text by the time this resolves, and `order` would say so.
     * Nothing here waits on a clock.
     */
    await new Promise<void>((resolve) => {
      const probe = new Image();
      probe.onload = () => {
        resolve();
      };
      probe.onerror = () => {
        resolve();
      };
      probe.src = gradientImage(64, 64, "#000000", "#ffffff");
    });

    expect(order, "the font is asked for first, and nothing measures behind it").toEqual([
      `load:${textFontString(64)}`,
    ]);

    release();
    const canvas = await rendering;
    expect(canvas.width).toBe(1080);
    expect(
      order.filter((entry) => entry === "measure").length,
      "the text is measured once the face has arrived",
    ).toBeGreaterThan(0);
  });
});

describe("renderSlideBlob", () => {
  it("encodes the canvas as a PNG", async () => {
    const blob = await renderSlideBlob(slideFixture(), {
      height: 1920,
      assets: backgroundOnly(),
    });
    expect(blob.type).toBe("image/png");
    const header = new Uint8Array((await blob.arrayBuffer()).slice(0, 8));
    expect(Array.from(header)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
