import { expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { Overlay } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import {
  LayerHarness,
  editorStore,
  layerElement,
  libraryFor,
  measuredStage,
  openLayerMenu,
  pickMenuItem,
  pointer,
} from "./testing.js";

/*
 * That a layer menu row can actually be picked.
 *
 * Radix portals the panel to document.body but keeps it a descendant of the
 * React tree, and React propagates along that tree. Every press on a row
 * therefore reached Stage's beginMarquee, which cleared the selection and
 * captured the pointer on the workspace surface, so the following pointerup
 * retargeted there and the row never fired.
 *
 * Every test here drives a real click. A raw element.click() is what hid this
 * in the first place: it skips the pointer sequence the bug lives in.
 */

async function open() {
  const project = fixtureProject({ texts: 0, overlays: 2 });
  const store = editorStore(project);
  await render(<LayerHarness store={store} library={libraryFor(project)} />);
  await measuredStage();
  const first = project.slides[0]?.overlays[0];
  const second = project.slides[0]?.overlays[1];
  if (first === undefined || second === undefined) throw new Error("Thin fixture.");
  return { store, first, second };
}

function overlayAt(
  store: ReturnType<typeof editorStore>,
  index: number,
): Overlay | undefined {
  return store.getSnapshot().project.slides[0]?.overlays[index];
}

it("reorders from the layer menu on a real click", async () => {
  const { store, first } = await open();
  expect(overlayAt(store, 0)?.z).toBeLessThan(overlayAt(store, 1)?.z ?? 0);

  openLayerMenu(layerElement("overlay", first.id));
  await pickMenuItem("Bring to front");

  await expect
    .poll(() => overlayAt(store, 0)?.z ?? 0)
    .toBeGreaterThan(overlayAt(store, 1)?.z ?? 0);
});

it("opens the crop editor from the layer menu on a real click", async () => {
  const { store, first } = await open();

  openLayerMenu(layerElement("overlay", first.id));
  await pickMenuItem("Crop");

  await expect.poll(() => store.getSnapshot().croppingOverlayId).toBe(first.id);
});

it("keeps the layer selected and the canvas out of a press on a menu row", async () => {
  const { store, first } = await open();
  openLayerMenu(layerElement("overlay", first.id));
  const row = page.getByRole("menuitem", { name: "Bring to front" });
  await expect.element(row).toBeVisible();
  const element = (await row.element()) as HTMLElement;
  await expect.poll(() => store.getSnapshot().selection.length).toBe(1);

  const surface = document.querySelector<HTMLElement>(
    '[data-testid="workspace-surface"]',
  );
  if (surface === null) throw new Error("No workspace surface.");
  let capturedByCanvas = false;
  const capture = surface.setPointerCapture.bind(surface);
  surface.setPointerCapture = (id: number) => {
    capturedByCanvas = true;
    capture(id);
  };

  element.dispatchEvent(pointer("pointerdown", 40, 40));

  /*
   * The two halves of the bug, each measured directly. beginMarquee clears the
   * selection on pointer down, and it captures the pointer on the surface,
   * which is what stops the row ever seeing the release.
   */
  expect(store.getSnapshot().selection).toHaveLength(1);
  expect(capturedByCanvas).toBe(false);
});
