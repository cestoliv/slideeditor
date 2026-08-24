import { expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import "../../../design/fonts.css";
import type { Project, TextLayer } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import type { EditorStore } from "../store.js";
import {
  LayerHarness,
  centreOf,
  editorStore,
  layerElement,
  libraryFor,
  measuredStage,
  pointer,
  press,
} from "./testing.js";

/*
 * The text layer, its render, and inline editing.
 *
 * Nothing here reads a class name. The render is checked through the shapes it
 * draws and the boxes they occupy, and the editor through what a reader would
 * see and where the caret lands, because those are the things the transparent
 * editor exists to protect.
 */

function textOf(store: EditorStore, index = 0): TextLayer {
  const text = store.getSnapshot().project.slides[0]?.texts[index];
  if (text === undefined) throw new Error("The text layer is gone.");
  return text;
}

async function open(prepare?: (text: TextLayer) => void) {
  const project: Project = fixtureProject({ texts: 1, overlays: 0 });
  const text = project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  text.x = 0.1;
  text.y = 0.3;
  text.width = 0.8;
  text.height = 0.2;
  text.size = 48;
  prepare?.(text);
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  const stage = await measuredStage();
  return { store, stage, id: text.id };
}

/** The clipped copy, which is the one a reader sees on the canvas. */
function insideOf(id: string): HTMLElement {
  const inside = layerElement("text", id).querySelector<HTMLElement>(
    '[data-testid="text-inside"]',
  );
  if (inside === null) throw new Error("No clipped text visual.");
  return inside;
}

function blockOf(id: string): HTMLElement {
  const block = insideOf(id).querySelector<HTMLElement>('[data-testid="text-block"]');
  if (block === null) throw new Error("No text block.");
  return block;
}

function renderedLines(id: string): string[] {
  return [...blockOf(id).children].map((child) => child.textContent ?? "");
}

/**
 * A press at a point on the canvas, delivered to whatever is topmost there.
 *
 * Dispatching on an element chosen in advance is what made the two-step
 * untestable: `event.target` was the box whatever the layer rendered, so
 * `closest("[data-text-content]")` was null however the hit area was gated. The
 * browser resolves the target here, the way it does for a real pointer.
 */
function pressAt(point: { x: number; y: number }): Element {
  const target = document.elementFromPoint(point.x, point.y);
  if (target === null) throw new Error("Nothing under the pointer.");
  target.dispatchEvent(pointer("pointerdown", point.x, point.y));
  target.dispatchEvent(pointer("pointerup", point.x, point.y));
  return target;
}

/** The centre of the first painted line, in client coordinates. */
function glyphPoint(id: string): { x: number; y: number } {
  const line = blockOf(id).children[0];
  if (line === undefined) throw new Error("No painted line.");
  const rect = line.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Selects the layer, then presses its glyphs, which is the two-step to edit. */
async function startEditing(id: string, at?: { x: number; y: number }) {
  const box = layerElement("text", id);
  press(box, centreOf(box));
  await expect
    .poll(() => insideOf(id).querySelector('[data-testid="text-hit"]'))
    .not.toBe(null);
  const target = insideOf(id).querySelector<HTMLElement>('[data-testid="text-hit"]');
  if (target === null) throw new Error("No editable glyphs.");
  const point = at ?? centreOf(target);
  target.dispatchEvent(pointer("pointerdown", point.x, point.y));
  const editor = page.getByRole("textbox", { name: "Edit text layer" });
  await expect.element(editor).toBeVisible();
  return (await editor.element()) as HTMLElement;
}

it("wraps text to the box width", async () => {
  const { store, id } = await open((text) => {
    text.text = "one two three four five six seven eight nine ten";
  });

  await expect.poll(() => renderedLines(id).length).toBeGreaterThan(1);
  const narrow = renderedLines(id);
  expect(narrow.join(" ").split(/\s+/).filter(Boolean)).toEqual(
    "one two three four five six seven eight nine ten".split(" "),
  );

  // A wider box holds the same words on fewer lines, which is the only thing
  // wrapping means. A renderer that split on a fixed count would not move.
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) text.size = 20;
  });
  await expect.poll(() => renderedLines(id).length).toBeLessThan(narrow.length);
});

it("draws an outline as an SVG stroke behind the fill", async () => {
  const { id } = await open((text) => {
    text.text = "Outlined";
    text.style = "outline";
    text.color = "#FFFFFF";
  });

  await expect.poll(() => blockOf(id).querySelectorAll("text").length).toBe(1);
  const glyphs = blockOf(id).querySelector("text");
  if (glyphs === null) throw new Error("No SVG text.");
  // paint-order is what puts the stroke behind the fill rather than over it.
  expect(glyphs.getAttribute("paint-order")).toBe("stroke fill");
  expect(glyphs.getAttribute("fill")).toBe("#FFFFFF");
  expect(glyphs.getAttribute("stroke")).toBe("#111111");
  expect(Number(glyphs.getAttribute("stroke-width"))).toBeGreaterThan(0);
});

it("draws one pill per line for a lines background", async () => {
  const { id } = await open((text) => {
    text.text = "first line\nsecond line\nthird";
    text.style = "boxed";
    text.backgroundShape = "lines";
  });

  await expect.poll(() => renderedLines(id).length).toBe(3);
  const svg = insideOf(id).querySelector('[data-testid="text-pills"]');
  if (svg === null) throw new Error("No pill background.");
  // Three pills, plus whatever notches join them into one ribbon.
  await expect.poll(() => svg.querySelectorAll("path").length).toBeGreaterThanOrEqual(3);
});

it("draws no pill for a blank line", async () => {
  const { id } = await open((text) => {
    text.text = "first\n\nthird";
    text.style = "boxed";
    text.backgroundShape = "lines";
    text.align = "left";
  });

  await expect.poll(() => renderedLines(id).length).toBe(3);
  const svg = insideOf(id).querySelector('[data-testid="text-pills"]');
  if (svg === null) throw new Error("No pill background.");
  // Left aligned text takes no notches, so every path is a pill, and the blank
  // line gets none of them.
  expect(svg.querySelectorAll("path")).toHaveLength(2);
});

it("draws one rounded box for a full background", async () => {
  const { id } = await open((text) => {
    text.text = "first line\nsecond line";
    text.style = "boxed";
    text.backgroundShape = "full";
  });

  await expect.poll(() => renderedLines(id).length).toBe(2);
  expect(insideOf(id).querySelector('[data-testid="text-pills"]')).toBe(null);
  const painted = [...insideOf(id).querySelectorAll<HTMLElement>("div")].filter(
    (element) => element.style.borderRadius !== "",
  );
  expect(painted).toHaveLength(1);
  expect(painted[0]?.style.background).toBe("rgb(255, 255, 255)");
});

it("renders a boxed text with no colour of its own dark on its white pill", async () => {
  const { id } = await open((text) => {
    text.text = "Legible";
    text.style = "boxed";
    text.backgroundShape = "lines";
    text.background = "white";
    // The document schema repairs a missing colour, so this is what a legacy
    // boxed layer arrives as.
    text.color = "";
  });

  await expect.poll(() => renderedLines(id)).toEqual(["Legible"]);
  const block = blockOf(id);
  await expect.poll(() => block.style.color).toBe("rgb(17, 17, 17)");
});

it("only starts editing on the second press of the two-step", async () => {
  const { id } = await open((text) => {
    text.text = "Two step";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Two step"]);
  const glyphs = glyphPoint(id);

  // First press, straight onto the glyphs. It selects and nothing more, which
  // is the affordance from commit 749e7f1.
  pressAt(glyphs);

  await expect.poll(() => layerElement("text", id).dataset["selected"]).toBe("true");
  expect(page.getByRole("textbox", { name: "Edit text layer" }).query()).toBe(null);

  // Second press, on the same pixel. Now the glyphs take it.
  pressAt(glyphs);

  await expect
    .element(page.getByRole("textbox", { name: "Edit text layer" }))
    .toBeVisible();
});

it("gives the glyphs no press of their own until the layer is selected", async () => {
  const { store, id } = await open((text) => {
    text.text = "Two step";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Two step"]);
  const glyphs = glyphPoint(id);
  const hitArea = () => insideOf(id).querySelector('[data-testid="text-hit"]');

  // styles.css:1798. Nothing over the glyphs takes a press while the layer is
  // unselected, so the press reaches the box and drags it instead. The second
  // assertion is on what the press would be read as, not on what element it
  // lands on: `not.toBe(null)` against a null hit area would say nothing.
  expect(hitArea()).toBe(null);
  expect(
    document.elementFromPoint(glyphs.x, glyphs.y)?.closest("[data-text-content]"),
  ).toBe(null);

  store.selectOnly("text", id);

  await expect.poll(hitArea).not.toBe(null);
  await expect.poll(() => document.elementFromPoint(glyphs.x, glyphs.y)).toBe(hitArea());
});

it("enters inline editing and keeps the caret where it was clicked", async () => {
  const { id } = await open((text) => {
    text.text = "abcdefghijklmnopqrstuvwxyz";
    text.align = "left";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["abcdefghijklmnopqrstuvwxyz"]);
  const line = blockOf(id).children[0];
  if (line === undefined) throw new Error("No painted line.");
  const lineBox = line.getBoundingClientRect();

  const clickX = lineBox.left + lineBox.width * 0.2;
  const editor = await startEditing(id, {
    x: clickX,
    y: lineBox.top + lineBox.height / 2,
  });

  expect(editor.textContent).toBe("abcdefghijklmnopqrstuvwxyz");
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) throw new Error("No caret.");
  const caret = selection.getRangeAt(0).getBoundingClientRect();
  // The caret sits where the pointer went, which is only true because the
  // editor's own text flow lands on the painted glyphs underneath it.
  expect(caret.left).toBeGreaterThan(lineBox.left);
  expect(Math.abs(caret.left - clickX)).toBeLessThan(12);
  // Collapsing to the end, which is the fallback, would put it here instead.
  expect(Math.abs(caret.left - lineBox.right)).toBeGreaterThan(40);
});

it("keeps the rendered text identical while editing", async () => {
  const { id } = await open((text) => {
    text.text = "Steady";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Steady"]);
  const before = (blockOf(id).children[0] as HTMLElement).getBoundingClientRect();

  const editor = await startEditing(id);

  const after = (blockOf(id).children[0] as HTMLElement).getBoundingClientRect();
  expect(after.left).toBeCloseTo(before.left, 1);
  expect(after.top).toBeCloseTo(before.top, 1);
  expect(after.width).toBeCloseTo(before.width, 1);
  // The editor paints nothing. What the reader sees is the render underneath,
  // which is why the glyphs above did not move.
  const painted = getComputedStyle(editor);
  expect(painted.webkitTextFillColor).toBe("rgba(0, 0, 0, 0)");
  expect(painted.caretColor).not.toBe("rgba(0, 0, 0, 0)");
});

it("focuses the editor when editing begins", async () => {
  const { id } = await open((text) => {
    text.text = "Steady";
  });

  const editor = await startEditing(id);

  // app.js:3944. Without this the caret is nowhere and the first keystroke goes
  // to the document. The preventScroll half of the call is not observable here,
  // and is not claimed to be.
  expect(document.activeElement).toBe(editor);
});

it("strips the trailing newline contenteditable reports", async () => {
  const { store, id } = await open((text) => {
    text.text = "Line";
  });
  const editor = await startEditing(id);

  editor.textContent = "Edited\n";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));

  expect(textOf(store).text).toBe("Edited");
});

it("leaves editing when a press lands off the glyphs", async () => {
  const { id } = await open((text) => {
    text.text = "Steady";
  });
  await startEditing(id);
  const box = layerElement("text", id).getBoundingClientRect();
  const line = glyphPoint(id);

  // Inside the box, above the block of lines. app.js:3821 commits the text
  // here, so the press that follows drags the layer rather than leaving it in
  // edit mode while it moves.
  const above = { x: box.left + box.width / 2, y: box.top + 4 };
  expect(above.y).toBeLessThan(line.y - 8);
  pressAt(above);

  await expect
    .poll(() => page.getByRole("textbox", { name: "Edit text layer" }).query())
    .toBe(null);
});

it("leaves editing on Escape and keeps the edit", async () => {
  const { store, id } = await open((text) => {
    text.text = "Before";
  });
  const editor = await startEditing(id);
  editor.textContent = "After";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  await expect
    .poll(() => page.getByRole("textbox", { name: "Edit text layer" }).query())
    .toBe(null);
  expect(textOf(store).text).toBe("After");
  // app.js:4844 hands focus back to the box, so a keyboard reader keeps place.
  expect(document.activeElement).toBe(layerElement("text", id));
  // The layer stays selected, so the inspector still describes it.
  expect(store.getSnapshot().selection).toEqual([`text:${id}`]);
});

it("leaves editing when the stage is clicked, and deselects", async () => {
  const { store, id } = await open();
  await startEditing(id);

  const surface = document.querySelector<HTMLElement>(
    '[data-testid="workspace-surface"]',
  );
  if (surface === null) throw new Error("No workspace surface.");
  surface.dispatchEvent(pointer("pointerdown", 4, 4));

  await expect
    .poll(() => page.getByRole("textbox", { name: "Edit text layer" }).query())
    .toBe(null);
  expect(store.getSnapshot().selection).toEqual([]);
});

it("keeps the layer selected when the edit is committed from the inspector", async () => {
  const project = fixtureProject({ texts: 1, overlays: 0 });
  const text = project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  const store = editorStore(project);
  await render(
    <LayerHarness
      store={store}
      library={libraryFor(project)}
      extras={
        <div data-inspector="true">
          <button type="button" data-testid="swatch">
            Colour
          </button>
        </div>
      }
    />,
  );
  await measuredStage();
  await startEditing(text.id);

  const swatch = await page.getByTestId("swatch").element();
  swatch.dispatchEvent(pointer("pointerdown", 5, 5));

  await expect
    .poll(() => page.getByRole("textbox", { name: "Edit text layer" }).query())
    .toBe(null);
  // app.js:4830. Pressing a control in the inspector commits the text and keeps
  // the layer selected, so the panel it belongs to is not emptied under it.
  expect(store.getSnapshot().selection).toEqual([`text:${text.id}`]);
});

it("starts editing from the keyboard on Enter", async () => {
  const { store, id } = await open();
  store.selectOnly("text", id);
  const box = layerElement("text", id);
  box.focus();
  // Enter opens the editor only once the layer is selected, mirroring the
  // two-step a pointer takes: on an unselected layer the first Enter selects it
  // (LayerBox's activation) and the second opens the editor.
  await expect.poll(() => box.dataset["selected"]).toBe("true");

  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  await expect
    .element(page.getByRole("textbox", { name: "Edit text layer" }))
    .toBeVisible();
});

it("grows the box height when the text needs another line", async () => {
  const { store, id } = await open((text) => {
    text.text = "one";
    text.height = 0.06;
    text.width = 0.3;
    text.size = 64;
  });
  const before = textOf(store).height;
  const editor = await startEditing(id);

  editor.textContent =
    "one two three four five six seven eight nine ten eleven twelve thirteen";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));

  await expect.poll(() => textOf(store).height).toBeGreaterThan(before);
});

it("never shrinks the box when a word is deleted", async () => {
  const { store, id } = await open((text) => {
    text.text = "one two three four five six seven eight";
    text.height = 0.3;
    text.width = 0.3;
  });
  const before = textOf(store).height;
  const editor = await startEditing(id);

  editor.textContent = "one";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));

  await expect.poll(() => textOf(store).text).toBe("one");
  expect(textOf(store).height).toBe(before);
});

it("adds a text layer on a double click on empty stage", async () => {
  const project = fixtureProject({ texts: 0, overlays: 0 });
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  await measuredStage();
  const stage = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (stage === null) throw new Error("No stage.");
  const rect = stage.getBoundingClientRect();

  stage.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width * 0.4,
      clientY: rect.top + rect.height * 0.6,
    }),
  );

  await expect.poll(() => store.getSnapshot().project.slides[0]?.texts.length).toBe(1);
  const added = textOf(store);
  expect(added.x + added.width / 2).toBeCloseTo(0.4, 2);
  expect(added.y + added.height / 2).toBeCloseTo(0.6, 2);
  // The new box opens for editing, so the placeholder can be typed over at once.
  await expect
    .element(page.getByRole("textbox", { name: "Edit text layer" }))
    .toBeVisible();
});

it("adds no text when the double click lands off the stage", async () => {
  const project = fixtureProject({ texts: 0, overlays: 0 });
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  await measuredStage();

  document.body.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      clientX: 2,
      clientY: 2,
    }),
  );

  expect(store.getSnapshot().project.slides[0]?.texts).toHaveLength(0);
});

it("moves a text layer with the pointer", async () => {
  const { store, stage, id } = await open();
  const start = { x: textOf(store).x, y: textOf(store).y };
  const box = layerElement("text", id);
  const from = centreOf(box);

  box.dispatchEvent(pointer("pointerdown", from.x, from.y));
  box.dispatchEvent(pointer("pointermove", from.x + 40, from.y + 20));
  box.dispatchEvent(pointer("pointerup", from.x + 40, from.y + 20));

  expect(textOf(store).x).toBeCloseTo(start.x + 40 / stage.width, 5);
  expect(textOf(store).y).toBeCloseTo(start.y + 20 / stage.height, 5);
});

it("deletes the selected text with the Delete key", async () => {
  const { store, id } = await open();
  store.selectOnly("text", id);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));

  expect(store.getSnapshot().project.slides[0]?.texts).toHaveLength(0);
});
