import { expect, it } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
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
} from "./testing.js";

/*
 * The text layer, its render, and inline editing.
 *
 * Nothing here reads a class name. The render is checked through the shapes it
 * draws and the boxes they occupy, and the editor through what a reader would
 * see and where the caret lands, because those are the things the inline
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
 * The browser resolves the target here, the way it does for a real pointer, so
 * a test cannot pass by dispatching on an element that would never be hit.
 */
function pressAt(point: { x: number; y: number }): Element {
  const target = document.elementFromPoint(point.x, point.y);
  if (target === null) throw new Error("Nothing under the pointer.");
  target.dispatchEvent(pointer("pointerdown", point.x, point.y));
  target.dispatchEvent(pointer("pointerup", point.x, point.y));
  return target;
}

/** Two presses and the dblclick the browser fires after them. */
function doubleClickAt(point: { x: number; y: number }): void {
  pressAt(point);
  const target = pressAt(point);
  target.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

/** The centre of the first painted line, in client coordinates. */
function glyphPoint(id: string): { x: number; y: number } {
  const line = blockOf(id).children[0];
  if (line === undefined) throw new Error("No painted line.");
  const rect = line.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The box of one character of a text node, the first by default. */
function glyphBox(node: ChildNode | null, index = 0): DOMRect {
  if (node === null) throw new Error("No text.");
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range.getBoundingClientRect();
}

/** The lines the browser broke the editor's text into, trailing spaces dropped. */
function editorLines(editor: HTMLElement): string[] {
  const node = editor.firstChild;
  if (!(node instanceof Text)) return [];
  const lines: string[] = [];
  let top: number | null = null;
  for (let index = 0; index < node.length; index++) {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getClientRects()[0];
    if (rect !== undefined && top !== null && Math.abs(rect.top - top) > 2) {
      lines.push("");
    }
    if (rect !== undefined) top = rect.top;
    if (lines.length === 0) lines.push("");
    lines[lines.length - 1] += node.data[index] ?? "";
  }
  return lines.map((line) => line.trimEnd());
}

/** Double clicks the glyphs, at their centre unless told otherwise. */
async function startEditing(id: string, at?: { x: number; y: number }) {
  doubleClickAt(at ?? glyphPoint(id));
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
    text.background = "#FFFFFF";
    // The document schema repairs a missing colour, so this is what a legacy
    // boxed layer arrives as.
    text.color = "";
  });

  await expect.poll(() => renderedLines(id)).toEqual(["Legible"]);
  const block = blockOf(id);
  await expect.poll(() => block.style.color).toBe("rgb(17, 17, 17)");
});

it("drags a selected layer from its glyphs rather than editing it", async () => {
  const { store, id } = await open((text) => {
    text.text = "Drag me";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Drag me"]);
  store.selectOnly("text", id);
  await expect.poll(() => layerElement("text", id).dataset["selected"]).toBe("true");
  const start = textOf(store).x;
  const glyphs = glyphPoint(id);

  // Select, resize, then drag is the main flow. A second press on the glyphs
  // used to open the editor, so the drag typed into the box instead.
  const target = document.elementFromPoint(glyphs.x, glyphs.y);
  if (target === null) throw new Error("Nothing under the pointer.");
  target.dispatchEvent(pointer("pointerdown", glyphs.x, glyphs.y));
  target.dispatchEvent(pointer("pointermove", glyphs.x + 40, glyphs.y));
  target.dispatchEvent(pointer("pointerup", glyphs.x + 40, glyphs.y));

  await expect.poll(() => textOf(store).x).toBeGreaterThan(start);
  expect(page.getByRole("textbox", { name: "Edit text layer" }).query()).toBe(null);
});

it("starts editing on a double click, even on an unselected layer", async () => {
  const { id } = await open((text) => {
    text.text = "Two clicks";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Two clicks"]);

  doubleClickAt(glyphPoint(id));

  await expect
    .element(page.getByRole("textbox", { name: "Edit text layer" }))
    .toBeVisible();
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

it("paints the editor's glyphs where the layout put them", async () => {
  const { id } = await open((text) => {
    text.text = "Steady\nhands";
  });
  await expect.poll(() => renderedLines(id)).toEqual(["Steady", "hands"]);

  const editor = await startEditing(id);
  // A real keystroke on the last line, so the glyphs are checked after an edit.
  window.getSelection()?.collapse(editor.firstChild, "Steady\nhands".length);
  await userEvent.keyboard("!");
  await expect.poll(() => renderedLines(id)).toEqual(["Steady", "hands!"]);

  // The editor paints the glyphs and the painted block steps aside, so the
  // caret is drawn on the very text it edits. The hidden block keeps its
  // layout, which is what the editor's glyphs are checked against. Polled,
  // because a face still loading under a busy suite moves both a frame apart.
  expect(getComputedStyle(blockOf(id)).visibility).toBe("hidden");
  expect(getComputedStyle(editor).color).not.toBe("rgba(0, 0, 0, 0)");
  const offsets = () => {
    const text = editor.firstChild;
    const edited = [glyphBox(text), glyphBox(text, "Steady\n".length)];
    return [...blockOf(id).children].flatMap((line, index) => {
      const painted = glyphBox(line.firstChild);
      const glyph = edited[index];
      if (glyph === undefined) return [Infinity];
      return [Math.abs(glyph.left - painted.left), Math.abs(glyph.top - painted.top)];
    });
  };
  await expect.poll(() => Math.max(...offsets())).toBeLessThan(0.05);
});

it("wraps the editor on the lines the layout drew", async () => {
  const words = "The quick brown foxes jump over the lazy dog and run far away";
  const { id } = await open((text) => {
    text.text = "";
    text.width = 0.4;
  });
  const editor = await startEditing(id);

  // Every prefix of the sentence, as it is typed, so some line ends inside the
  // wrap inset. An editor wider than the wrap column keeps a word there that
  // the layout broke.
  for (let end = 1; end <= words.length; end++) {
    const value = words.slice(0, end).trimEnd();
    editor.textContent = value;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await expect.poll(() => renderedLines(id).join(" ")).toBe(value);
    // Polled, because a face still loading under a busy suite settles the
    // layout a frame after the editor.
    await expect
      .poll(() => ({ editor: editorLines(editor), painted: renderedLines(id) }))
      .toSatisfy(({ editor, painted }) => editor.join("\n") === painted.join("\n"));
  }
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
  // Enter opens the editor only once the layer is selected: on an unselected
  // layer the first Enter selects it (LayerBox's activation) and the second
  // opens the editor.
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
