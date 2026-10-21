import { beforeAll, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import "../../../design/fonts.css";
import tiktokSansUrl from "@assets/TikTokSans.ttf?url";
import { composeDocument } from "@shared/compose/index.js";
import type { Composition, LibraryLookup } from "@shared/compose/index.js";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import { BUILTIN_DEFAULTS } from "@shared/schema/index.js";
import type { AccountDefaults, LibraryItem, Project } from "@shared/schema/index.js";
import { TEXT_WEIGHT, readFontMetrics, textFontString } from "@shared/text/index.js";
import type { MeasureFont } from "@shared/text/index.js";
import { fixtureProject } from "../testing.js";
import {
  LayerHarness,
  editorStore,
  layerElement,
  libraryFor,
  libraryItem,
} from "../layers/testing.js";
import type { EditorStore } from "../store.js";
import { useFitTextBoxes } from "./useFitTextBoxes.js";
import { layoutAt } from "./useTextLayout.js";

/*
 * Project 4f944c8b (3:4, boxed lines, TikTok Sans, text 0.6 wide), composed
 * the way the server composes it, then drawn by the editor's own stage.
 * Production stored its boxes exactly as tall as their lines, so the stage
 * dropped the last line of two of them at some window sizes and cut every
 * pill at the box edge.
 */

const DEFAULTS: AccountDefaults = {
  ratio: { w: 3, h: 4 },
  text: {
    ...BUILTIN_DEFAULTS.text,
    size: 48,
    style: "boxed",
    color: "#111111",
    background: "#FFFFFF",
    backgroundShape: "lines",
    maxWidth: 0.6,
  },
};

const SLIDES: Composition[] = [
  {
    background: "couple",
    texts: [{ text: "elle m'a dit que j'avais changé", size: 64 }],
  },
  { background: "curl", texts: ["un curl sur 6 mois : de 26 à 34 kg"] },
  { background: "disque", assets: ["logo"], texts: ["elle avait raison"] },
  // One line at the export's size, two at a stage's, where TikTok Sans
  // draws its wider optical size.
  { background: "curl", texts: ["un curl sur 6 mois de 26 à 34"] },
];

const ITEMS = new Map<string, LibraryItem>([
  [
    "couple",
    {
      ...libraryItem("couple", 1200, 1600),
      layoutHints: { freeZone: "top", subject: { x: 0.1, y: 0.31, w: 0.55, h: 0.5 } },
    },
  ],
  [
    "curl",
    {
      ...libraryItem("curl", 1206, 1608),
      layoutHints: { freeZone: "top", subject: { x: 0.1, y: 0.35, w: 0.9, h: 0.5 } },
    },
  ],
  [
    "disque",
    {
      ...libraryItem("disque", 1200, 1600),
      layoutHints: { freeZone: "bottom", subject: { x: 0.08, y: 0.15, w: 0.55, h: 0.6 } },
    },
  ],
  ["logo", { ...libraryItem("logo", 1000, 300), kind: "asset" }],
]);

const library: LibraryLookup = {
  require: (id) => {
    const item = ITEMS.get(id);
    if (item === undefined) throw new Error(`No library item ${id}`);
    return item;
  },
};

let project: Project;

beforeAll(async () => {
  await document.fonts.load(textFontString(48, "TikTok Sans"));
  const bytes = new Uint8Array(await (await fetch(tiktokSansUrl)).arrayBuffer());
  const metrics = readFontMetrics(bytes);
  if (metrics === null) throw new Error("TikTok Sans did not parse.");
  // What FontService.measureText does for a builtin.
  const measureText: MeasureFont = (line, font) =>
    metrics.measure(line, font.size, font.weight ?? TEXT_WEIGHT);
  let id = 0;
  const composed = composeDocument({
    ratio: DEFAULTS.ratio,
    slides: SLIDES,
    library,
    defaults: DEFAULTS,
    measureText,
    newId: () => `id-${String(id++)}`,
  });
  project = { ...fixtureProject(), ...composed };
});

/** The heights production stored for the example, which hold its lines but not its pills. */
const STORED = [0.10844444444444447, 0.08133333333333334, 0.044000000000000004];

it("composes the example's boxes a pill overhang taller than production stored them", () => {
  // A pill is 1.42 em on a 1.12 em line, which takes 0.1 em more than the
  // 0.1 em of padding at each edge plain text keeps.
  project.slides.slice(0, 3).forEach((slide, index) => {
    const text = slide.texts[0];
    if (text === undefined) throw new Error("A slide lost its text.");
    expect(text.height).toBeCloseTo((STORED[index] ?? 0) + (0.1 * text.size) / 1440, 9);
  });
});

/** Stage sizes in no particular step, so the browser's layout rounding falls both ways. */
const FRAMES = Array.from({ length: 24 }, (_, index) => ({
  width: 420 + index * 23.7,
  height: 560 + ((index * 37) % 300),
}));

it("draws every line of every composed box, at every stage size", async () => {
  const store = editorStore(project);
  const harness = (frame: { width: number; height: number }) => (
    <LayerHarness store={store} library={libraryFor(project)} frame={frame} />
  );
  const screen = await render(harness({ width: 300, height: 300 }));
  const canvas = { width: OUTPUT_WIDTH, height: outputHeight(project.ratio) };
  const widths = new Set<number>();

  for (const frame of FRAMES) {
    const before = stageWidth();
    await screen.rerender(harness(frame));
    await expect.poll(stageWidth).not.toBe(before);
    widths.add(stageWidth());
    for (const slide of project.slides) {
      store.setActiveSlide(slide.id);
      for (const text of slide.texts) {
        const exported = layoutAt(text, canvas);
        expect(exported.lines).toHaveLength(exported.totalLineCount);
        await expect.poll(() => linesOf(text.id)).toEqual(exported.lines);
        // Every line sits inside the box rather than overflowing it.
        const inside = insideOf(text.id);
        expect(
          inside.scrollHeight,
          `${text.text} at ${frameName(frame)}`,
        ).toBeLessThanOrEqual(inside.clientHeight);
        expectPillsInside(text.id);
      }
    }
  }
  expect(widths.size).toBe(FRAMES.length);
  await screen.unmount();
});

it("shows every pill of a box stored too short for them", async () => {
  // The example as production stored it, before boxes counted their pills.
  const stored: Project = {
    ...project,
    slides: project.slides.slice(0, 3).map((slide, index) => ({
      ...slide,
      texts: slide.texts.map((text) => ({ ...text, height: STORED[index] ?? 0 })),
    })),
  };
  const store = editorStore(stored);
  const screen = await render(
    <>
      <Fit store={store} />
      <LayerHarness store={store} library={libraryFor(stored)} />
    </>,
  );
  for (const slide of stored.slides) {
    store.setActiveSlide(slide.id);
    for (const text of slide.texts) {
      await expect.poll(() => linesOf(text.id).length).toBeGreaterThan(0);
      const clip = clipRectOf(insideOf(text.id));
      for (const pill of pillsOf(text.id)) {
        const rect = pill.getBoundingClientRect();
        expect(rect.top, `pill top of ${text.text}`).toBeGreaterThanOrEqual(clip.top);
        expect(rect.bottom, `pill bottom of ${text.text}`).toBeLessThanOrEqual(
          clip.bottom,
        );
      }
    }
  }
  // Every line shows, so the fit hook leaves each stored height alone: a
  // height it changed would count the slide in layoutChanged. Long enough
  // for the face to settle and the hook to run.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const heights = store
    .getSnapshot()
    .project.slides.map((slide) => slide.texts[0]?.height);
  expect(heights).toEqual(STORED);
  await screen.unmount();
});

it("cuts a plain text at its own box, as the export does", async () => {
  const plain: Project = {
    ...project,
    slides: project.slides.slice(0, 1).map((slide) => ({
      ...slide,
      texts: slide.texts.map((text) => ({ ...text, style: "plain" as const })),
    })),
  };
  const store = editorStore(plain);
  const screen = await render(<LayerHarness store={store} library={libraryFor(plain)} />);
  const text = plain.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The slide lost its text.");
  await expect.poll(() => linesOf(text.id).length).toBeGreaterThan(0);
  expect(insideOf(text.id).style.clipPath).toBe("inset(0%)");
  await screen.unmount();
});

it("keeps the pills whole while a text is edited, and cuts only the editor at its box", async () => {
  const slide = project.slides[0];
  const text = slide?.texts[0];
  if (slide === undefined || text === undefined) throw new Error("No text to edit.");
  const stored: Project = {
    ...project,
    slides: [{ ...slide, texts: [{ ...text, height: STORED[0] ?? 0 }] }],
  };
  const store = editorStore(stored);
  const screen = await render(
    <LayerHarness store={store} library={libraryFor(stored)} />,
  );
  await expect.poll(() => linesOf(text.id).length).toBeGreaterThan(0);
  const box = layerElement("text", text.id);
  const { left, top, width, height } = box.getBoundingClientRect();
  const at = { bubbles: true, clientX: left + width / 2, clientY: top + height / 2 };
  box.dispatchEvent(new MouseEvent("dblclick", { ...at, cancelable: true, button: 0 }));
  await expect
    .poll(() =>
      box.querySelector('[data-testid="text-editor-clip"]')?.getAttribute("style"),
    )
    .toContain("inset(0%)");
  const clip = clipRectOf(insideOf(text.id));
  for (const pill of pillsOf(text.id)) {
    const rect = pill.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(clip.top);
    expect(rect.bottom).toBeLessThanOrEqual(clip.bottom);
  }
  await screen.unmount();
});

function Fit({ store }: { store: EditorStore }) {
  useFitTextBoxes(store);
  return null;
}

/** The rectangle an element's inline `clip-path: inset(…)` leaves visible. */
function clipRectOf(element: HTMLElement): { top: number; bottom: number } {
  const box = element.getBoundingClientRect();
  const [top = 0, , bottom = 0] = [
    ...element.style.clipPath.matchAll(/(-?[\d.e+-]+)%/g),
  ].map((match) => Number(match[1]) / 100);
  return { top: box.top + top * box.height, bottom: box.bottom - bottom * box.height };
}

function pillsOf(id: string): Element[] {
  return [...insideOf(id).querySelectorAll('[data-testid="text-pills"] path')];
}

/** Every pill of a boxed text lies within its own box. */
function expectPillsInside(id: string): void {
  const box = insideOf(id).getBoundingClientRect();
  for (const pill of pillsOf(id)) {
    const rect = pill.getBoundingClientRect();
    // A layout unit is 1/64px, so the box's own edges land that far off.
    expect(rect.top, `pill top of ${id}`).toBeGreaterThanOrEqual(box.top - 0.05);
    expect(rect.bottom, `pill bottom of ${id}`).toBeLessThanOrEqual(box.bottom + 0.05);
  }
}

function stageWidth(): number {
  const stack = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
  return Number(stack?.dataset["stageWidth"] ?? 0);
}

function insideOf(id: string): HTMLElement {
  const inside = layerElement("text", id).querySelector<HTMLElement>(
    '[data-testid="text-inside"]',
  );
  if (inside === null) throw new Error("No text visual.");
  return inside;
}

function linesOf(id: string): string[] {
  const block = insideOf(id).querySelector('[data-testid="text-block"]');
  return [...(block?.children ?? [])].map((line) => line.textContent);
}

function frameName(frame: { width: number; height: number }): string {
  return `${String(frame.width)}x${String(frame.height)}`;
}
