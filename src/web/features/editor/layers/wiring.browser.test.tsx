import { expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { Editor } from "../Editor.js";
import type { EditorClient } from "../Editor.js";
import { fixtureProject } from "../testing.js";
import { libraryItem } from "./testing.js";

/*
 * That the layers are reachable from the app, not only from the layer tests'
 * own harness.
 *
 * This is the one thing a unit test of the stack cannot show: a component can
 * be complete, tested and never rendered. The library feature sat unreachable
 * for a whole round for exactly that reason, so the wiring gets its own test.
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
  const items = project.slides.flatMap((slide) => [
    libraryItem(slide.backgroundItemId),
    ...slide.overlays.map((overlay) => libraryItem(overlay.itemId)),
  ]);
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items, total: items.length }),
  });
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
}

it("renders the slide's layers inside the editor", async () => {
  const project = fixtureProject({ texts: 1, overlays: 1 });

  await openEditor(project);

  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  await expect.element(page.getByLabelText(/^Text layer/)).toBeInTheDocument();
});

it("selects a layer pressed inside the editor", async () => {
  const project = fixtureProject({ texts: 0, overlays: 1 });
  const id = project.slides[0]?.overlays[0]?.id;
  if (id === undefined) throw new Error("The fixture has no overlay.");

  await openEditor(project);
  const box = await page.getByLabelText(/^Photo overlay/).element();
  const rect = box.getBoundingClientRect();
  box.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );

  // The store is the editor's own, so the selection is only observable through
  // what the layer paints. data-selected is what LayerBox writes for it.
  await expect.poll(() => box.getAttribute("data-selected")).toBe("true");
});
