import { expect, it } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { Editor } from "../Editor.js";
import type { EditorClient } from "../Editor.js";
import { fixtureProject } from "../testing.js";
import { libraryItem } from "./testing.js";

/*
 * Operating a canvas layer with no pointer at all.
 *
 * `tabIndex={0}` made every layer a Tab stop, and a Tab stop is a promise that
 * something is operable there. Nothing was: Enter and Space did nothing, so a
 * keyboard reader could reach a layer and then go no further. Everything that
 * hangs off a selection — the inspector, the words, the colour, the size, the
 * position — was reachable only with a mouse.
 *
 * Nothing in this file dispatches a pointer event. A test that clicks and then
 * presses a key has not tested the keyboard path.
 */

function client(project: Project): EditorClient {
  return {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent) =>
      Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 }),
    setStatus: () => Promise.resolve({}),
  };
}

function library(project: Project): LibraryCache {
  const items: LibraryItem[] = project.slides.flatMap((slide) => [
    libraryItem(slide.backgroundItemId),
    ...slide.overlays.map((overlay) => libraryItem(overlay.itemId)),
  ]);
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items, total: items.length }),
  });
}

function projectWith(options: { texts?: number; overlays?: number } = {}) {
  const project = fixtureProject({
    texts: options.texts ?? 1,
    overlays: options.overlays ?? 0,
  });
  const text = project.slides[0]?.texts[0];
  if (text !== undefined) text.text = "Reach me";
  return project;
}

async function openEditor(project: Project) {
  await render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/p/project-1"]}>
        <Editor
          projectId={project.id}
          client={client(project)}
          library={library(project)}
          subscribe={() => () => undefined}
        />
      </MemoryRouter>
    </ToastProvider>,
  );
  await expect.element(page.getByLabelText("Layer settings")).toBeInTheDocument();
}

/**
 * Tabs until the focus lands on a canvas layer, and answers which one.
 *
 * The bound is generous but finite: a rail, a header and an inspector all sit
 * before the canvas in the tab order, and a run that never arrives should fail
 * as a run rather than hang.
 */
async function tabToLayer(): Promise<HTMLElement> {
  for (let step = 0; step < 60; step += 1) {
    await userEvent.tab();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.dataset["layerKind"] !== undefined) {
      return focused;
    }
  }
  throw new Error("Tab never reached a canvas layer.");
}

function selectionOf(box: HTMLElement): string | undefined {
  return box.dataset["selected"];
}

function inspectorText(): string {
  return document.querySelector("[data-inspector]")?.textContent ?? "";
}

it("reaches a layer by Tab alone and selects it with Enter", async () => {
  await openEditor(projectWith({ texts: 1 }));

  const box = await tabToLayer();
  expect(box.dataset["layerKind"], "the focus landed on a layer").toBe("text");
  expect(selectionOf(box), "nothing is selected yet").toBeUndefined();

  await userEvent.keyboard("{Enter}");

  expect(selectionOf(box), "Enter selected the layer").toBe("true");
  /*
   * The inspector is the whole point: without a selection it offers the slide,
   * and every word, colour, size and alignment a person would change is behind
   * it. Asserted on its content rather than on visibility, because below the
   * 780px breakpoint it is a sheet the toggle opens (Inspector.module.css), and
   * the test viewport is 414px wide.
   */
  await expect.poll(() => inspectorText()).toContain("Text settings");
  expect(inspectorText(), "the inspector describes this layer").toContain("Reach me");
});

it("selects with Space as well", async () => {
  await openEditor(projectWith({ texts: 1 }));
  const box = await tabToLayer();

  await userEvent.keyboard(" ");

  expect(selectionOf(box)).toBe("true");
  await expect.poll(() => inspectorText()).toContain("Text settings");
});

it("announces the layer as something operable", async () => {
  await openEditor(projectWith({ texts: 1 }));
  const box = await tabToLayer();

  // A bare div is announced as a group, which tells a reader nothing about what
  // pressing it would do.
  expect(box.getAttribute("role")).toBe("button");
  expect(box.getAttribute("aria-pressed")).toBe("false");

  await userEvent.keyboard("{Enter}");

  expect(box.getAttribute("aria-pressed")).toBe("true");
});

it("keeps the focus on the layer it selected", async () => {
  await openEditor(projectWith({ texts: 1 }));
  const box = await tabToLayer();

  await userEvent.keyboard("{Enter}");

  // Selecting must not move the focus, or the next keystroke goes elsewhere and
  // the arrows below would act on nothing.
  expect(document.activeElement).toBe(box);
});

it("backs out of a selection with Escape", async () => {
  await openEditor(projectWith({ texts: 1 }));
  const box = await tabToLayer();
  await userEvent.keyboard("{Enter}");
  expect(selectionOf(box)).toBe("true");

  await userEvent.keyboard("{Escape}");

  await expect.poll(() => selectionOf(box)).toBeUndefined();
  // Still on the layer, so Tab carries on from where the reader was.
  expect(document.activeElement).toBe(box);
});

it("nudges the selected layer with the arrow keys", async () => {
  const project = projectWith({ texts: 1 });
  const before = project.slides[0]?.texts[0];
  if (before === undefined) throw new Error("The fixture has no text.");
  const start = { x: before.x, y: before.y };
  await openEditor(project);
  const box = await tabToLayer();
  await userEvent.keyboard("{Enter}");

  const left = () => parseFloat(box.style.left) / 100;
  const top = () => parseFloat(box.style.top) / 100;
  expect(left()).toBeCloseTo(start.x, 6);

  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(left).toBeGreaterThan(start.x);
  const afterOne = left();

  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(top).toBeGreaterThan(start.y);

  // Shift moves further, so a layer can be walked across the canvas without a
  // hundred presses.
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  await expect.poll(left).toBeGreaterThan(afterOne + (afterOne - start.x));
});

it("nudges nothing while a text layer is being edited", async () => {
  const project = projectWith({ texts: 1 });
  await openEditor(project);
  const box = await tabToLayer();
  await userEvent.keyboard("{Enter}");
  const placed = box.style.left;
  // A second Enter opens the editor, mirroring the two-step a pointer takes.
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("textbox", { name: "Edit text layer" }))
    .toBeVisible();

  await userEvent.keyboard("{ArrowRight}");

  // The caret owns the arrows inside a field.
  expect(box.style.left).toBe(placed);
});

it("nudges nothing while a field elsewhere has the focus", async () => {
  const project = projectWith({ texts: 1 });
  await openEditor(project);
  const box = await tabToLayer();
  await userEvent.keyboard("{Enter}");
  const placed = box.style.left;

  // The slideshow's name, which is a plain input a long way from the canvas.
  const name = await page.getByLabelText("Slideshow name").element();
  (name as HTMLInputElement).focus();
  await userEvent.keyboard("{ArrowRight}");

  // app.js:4593. A field owns its arrows: they walk the caret, not the layer.
  expect(box.style.left).toBe(placed);
  // And the selection is untouched, so the reader comes back to what they left.
  expect(selectionOf(box)).toBe("true");
});

it("reaches an overlay the same way", async () => {
  await openEditor(projectWith({ texts: 0, overlays: 1 }));

  const box = await tabToLayer();
  expect(box.dataset["layerKind"]).toBe("overlay");
  await userEvent.keyboard("{Enter}");

  expect(selectionOf(box)).toBe("true");
  await expect.poll(() => inspectorText()).toContain("Overlay");
});
