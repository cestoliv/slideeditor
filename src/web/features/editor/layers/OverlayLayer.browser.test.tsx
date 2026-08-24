import { expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { Overlay, Project } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import type { EditorStore } from "../store.js";
import { getOverlayMetrics } from "@shared/geometry/index.js";
import {
  LayerHarness,
  centreOf,
  drag,
  editorStore,
  layerElement,
  libraryFor,
  measuredStage,
  openLayerMenu,
  pickMenuItem,
  pointer,
  press,
  stackElement,
} from "./testing.js";

/** The centre the rotate gesture turns about, computed the way it computes it. */
function rotationCentre(store: EditorStore): { x: number; y: number } {
  const overlay = overlayOf(store);
  const rect = stackElement().getBoundingClientRect();
  const metrics = getOverlayMetrics(
    overlay,
    { width: 1080, height: 1080 },
    {
      ratio: store.getSnapshot().project.ratio,
    },
  );
  return {
    x: rect.left + (overlay.x + metrics.width / 2) * rect.width,
    y: rect.top + (overlay.y + metrics.height / 2) * rect.height,
  };
}

/*
 * Every pointer gesture on an overlay, driven through the real Stage and the
 * real layer stack. The assertions are on the document the store holds, because
 * that is what a save writes and what an export draws, and on the DOM only
 * where the DOM is the behaviour.
 */

function projectWithOverlay(): Project {
  const project = fixtureProject({ texts: 0, overlays: 1 });
  const overlay = project.slides[0]?.overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  overlay.x = 0.3;
  overlay.y = 0.3;
  overlay.width = 0.3;
  overlay.height = 0.3;
  return project;
}

/**
 * The same overlay with half of the asset cropped away, centred on it.
 *
 * The identity crop above cannot exercise subtlety 6 at all:
 * expandOverlayForCrop returns an overlay untouched when its crop is the
 * identity (overlay.ts:250-252), so a test built on it cannot tell the un-apply
 * from a no-op.
 */
function projectWithCroppedOverlay(): Project {
  const project = projectWithOverlay();
  const overlay = project.slides[0]?.overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  overlay.cropX = 0.25;
  overlay.cropY = 0.25;
  overlay.cropW = 0.5;
  overlay.cropH = 0.5;
  return project;
}

function overlayOf(store: EditorStore, index = 0): Overlay {
  const overlay = store.getSnapshot().project.slides[0]?.overlays[index];
  if (overlay === undefined) throw new Error("The overlay is gone.");
  return overlay;
}

async function open(project: Project = projectWithOverlay()) {
  const store = editorStore(project);
  const library = libraryFor(project);
  await render(<LayerHarness store={store} library={library} />);
  const stage = await measuredStage();
  return { store, stage };
}

function handleOf(overlayId: string, handle: string): HTMLElement {
  const element = layerElement("overlay", overlayId).querySelector<HTMLElement>(
    `[data-handle="${handle}"]`,
  );
  if (element === null) throw new Error(`No ${handle} handle on the overlay.`);
  return element;
}

it("selects an overlay on pointer down", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  expect(store.getSnapshot().selection).toEqual([]);

  press(layerElement("overlay", id), centreOf(layerElement("overlay", id)));

  expect(store.getSnapshot().selection).toEqual([`overlay:${id}`]);
  expect(store.getSnapshot().primary).toBe(`overlay:${id}`);
});

it("adds to the selection when the modifier is held", async () => {
  const project = fixtureProject({ texts: 0, overlays: 2 });
  const { store } = await open(project);
  const first = overlayOf(store, 0).id;
  const second = overlayOf(store, 1).id;

  press(layerElement("overlay", first), centreOf(layerElement("overlay", first)));
  press(layerElement("overlay", second), centreOf(layerElement("overlay", second)), {
    metaKey: true,
  });

  expect(new Set(store.getSnapshot().selection)).toEqual(
    new Set([`overlay:${first}`, `overlay:${second}`]),
  );
});

it("does not drag a layer that a modifier click only toggled", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  const start = { ...overlayOf(store) };
  const from = centreOf(layerElement("overlay", id));

  drag(
    layerElement("overlay", id),
    from,
    { x: from.x + 80, y: from.y + 40 },
    { metaKey: true },
  );

  expect(overlayOf(store).x).toBe(start.x);
  expect(overlayOf(store).y).toBe(start.y);
});

it("moves an overlay by the pointer delta", async () => {
  const { store, stage } = await open();
  const id = overlayOf(store).id;
  const start = { ...overlayOf(store) };
  const from = centreOf(layerElement("overlay", id));

  drag(layerElement("overlay", id), from, { x: from.x + 64, y: from.y + 32 });

  expect(overlayOf(store).x).toBeCloseTo(start.x + 64 / stage.width, 5);
  expect(overlayOf(store).y).toBeCloseTo(start.y + 32 / stage.height, 5);
});

it("moves every selected layer together", async () => {
  const project = fixtureProject({ texts: 1, overlays: 1 });
  const { store, stage } = await open(project);
  const overlayId = overlayOf(store).id;
  const text = store.getSnapshot().project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  const startText = { x: text.x, y: text.y };
  const startOverlay = { x: overlayOf(store).x, y: overlayOf(store).y };

  store.select([`overlay:${overlayId}`, `text:${text.id}`]);
  const from = centreOf(layerElement("overlay", overlayId));
  drag(layerElement("overlay", overlayId), from, { x: from.x + 50, y: from.y });

  expect(overlayOf(store).x).toBeCloseTo(startOverlay.x + 50 / stage.width, 5);
  expect(text.x).toBeCloseTo(startText.x + 50 / stage.width, 5);
  expect(text.y).toBeCloseTo(startText.y, 5);
});

it("leaves one undo entry behind a whole drag", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  const start = { ...overlayOf(store) };
  const box = layerElement("overlay", id);
  const from = centreOf(box);

  box.dispatchEvent(pointer("pointerdown", from.x, from.y));
  for (let step = 1; step <= 20; step += 1) {
    box.dispatchEvent(pointer("pointermove", from.x + step * 3, from.y + step * 2));
  }
  box.dispatchEvent(pointer("pointerup", from.x + 60, from.y + 40));
  expect(overlayOf(store).x).not.toBe(start.x);

  store.undo();

  expect(overlayOf(store).x).toBeCloseTo(start.x, 6);
  expect(overlayOf(store).y).toBeCloseTo(start.y, 6);
  // One entry, so a second undo has nothing of this drag left to take back.
  expect(store.canUndo()).toBe(false);
});

it("resizes from a corner and keeps the aspect ratio", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  store.selectOnly("overlay", id);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  const start = { ...overlayOf(store) };
  const handle = handleOf(id, "se");
  const from = centreOf(handle);

  drag(handle, from, { x: from.x + 60, y: from.y });

  const next = overlayOf(store);
  expect(next.width).toBeGreaterThan(start.width);
  expect(next.width / (next.height ?? 1)).toBeCloseTo(
    start.width / (start.height ?? 1),
    5,
  );
});

it("resizes freely from a corner when alt is held", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  store.selectOnly("overlay", id);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  const start = { ...overlayOf(store) };
  const handle = handleOf(id, "se");
  const from = centreOf(handle);

  drag(handle, from, { x: from.x + 60, y: from.y }, { altKey: true });

  const next = overlayOf(store);
  expect(next.width).toBeGreaterThan(start.width);
  // The pointer never moved vertically, so a free resize leaves the height
  // exactly where it was while an aspect-preserving one would have grown it.
  expect(next.height).toBeCloseTo(start.height ?? 0, 6);
});

it("rotates around the layer's centre", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  store.selectOnly("overlay", id);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  const box = layerElement("overlay", id);
  const centre = rotationCentre(store);
  const rotate = box.querySelector<HTMLElement>("[data-rotate]");
  if (rotate === null) throw new Error("No rotate handle.");

  // Twelve o'clock to three o'clock about the centre is a quarter turn.
  drag(rotate, { x: centre.x, y: centre.y - 100 }, { x: centre.x + 100, y: centre.y });

  expect(overlayOf(store).rotation).toBeCloseTo(90, 6);
});

it("snaps a rotation to fifteen degrees while shift is held", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  store.selectOnly("overlay", id);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  const box = layerElement("overlay", id);
  const centre = rotationCentre(store);
  const rotate = box.querySelector<HTMLElement>("[data-rotate]");
  if (rotate === null) throw new Error("No rotate handle.");

  drag(
    rotate,
    { x: centre.x, y: centre.y - 100 },
    { x: centre.x + 100, y: centre.y - 12 },
    { shiftKey: true },
  );

  expect(overlayOf(store).rotation % 15).toBeCloseTo(0, 6);
});

it("moves along the layer's own axes when it is rotated", async () => {
  const { store, stage } = await open();
  const id = overlayOf(store).id;
  store.mutate((document) => {
    const overlay = document.slides[0]?.overlays[0];
    if (overlay !== undefined) overlay.rotation = 90;
  });
  store.selectOnly("overlay", id);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  const start = { ...overlayOf(store) };
  const handle = handleOf(id, "e");
  const from = centreOf(handle);

  // The layer is a quarter turn clockwise, so its own east is the stage's
  // south. A hundred pixels down therefore widens it by a hundred pixels.
  drag(handle, from, { x: from.x, y: from.y + 100 });

  expect(overlayOf(store).width).toBeCloseTo(start.width + 100 / stage.width, 4);
  // Rotating the normalized numbers instead of the pixels would have divided
  // that hundred by the stage height, which on a 9:16 stage is a different
  // number entirely.
  expect(overlayOf(store).width).not.toBeCloseTo(start.width + 100 / stage.height, 4);
});

it("deletes an overlay dropped on the trash", async () => {
  const project = projectWithOverlay();
  const store = editorStore(project);
  const library = libraryFor(project);
  await render(
    <LayerHarness
      store={store}
      library={library}
      extras={
        <div
          data-asset-trash="true"
          data-testid="trash"
          style={{
            position: "fixed",
            right: "0px",
            bottom: "0px",
            width: "80px",
            height: "80px",
          }}
        />
      }
    />,
  );
  await measuredStage();
  const id = overlayOf(store).id;
  const trash = document.querySelector<HTMLElement>("[data-asset-trash]");
  if (trash === null) throw new Error("No trash.");
  await expect.element(page.getByTestId("trash")).toBeInTheDocument();
  const target = centreOf(trash);
  const box = layerElement("overlay", id);
  const from = centreOf(box);

  box.dispatchEvent(pointer("pointerdown", from.x, from.y));
  box.dispatchEvent(pointer("pointermove", target.x, target.y));
  expect(trash.hasAttribute("data-asset-trash-hot")).toBe(true);
  box.dispatchEvent(pointer("pointerup", target.x, target.y));

  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(0);
  expect(trash.hasAttribute("data-asset-trash-hot")).toBe(false);
});

it("keeps an overlay released away from the trash", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  const from = centreOf(layerElement("overlay", id));

  drag(layerElement("overlay", id), from, { x: from.x + 20, y: from.y + 20 });

  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(1);
});

it("does not commit an open crop on a right click", async () => {
  const project = fixtureProject({ texts: 1, overlays: 1 });
  const overlay = project.slides[0]?.overlays[0];
  const text = project.slides[0]?.texts[0];
  if (overlay === undefined || text === undefined) throw new Error("Thin fixture.");
  overlay.cropX = 0.25;
  overlay.cropY = 0.25;
  overlay.cropW = 0.5;
  overlay.cropH = 0.5;
  const { store } = await open(project);

  openLayerMenu(layerElement("overlay", overlay.id));
  await pickMenuItem("Crop");
  await expect.poll(() => store.getSnapshot().croppingOverlayId).toBe(overlay.id);
  const widened = overlayOf(store).width;
  expect(widened).toBeCloseTo(0.68, 6);

  /*
   * app.js:3489 returns before the finishCrop branch for a secondary button, so
   * a right click on another layer opens that layer's menu and commits nothing.
   * useLayerDrag refuses a non-primary button on its own, which covers the drag
   * half of the same guard; this covers the other half.
   */
  const box = layerElement("text", text.id);
  const at = centreOf(box);
  box.dispatchEvent(pointer("pointerdown", at.x, at.y, { button: 2, buttons: 2 }));

  expect(store.getSnapshot().croppingOverlayId).toBe(overlay.id);
  expect(overlayOf(store).width).toBeCloseTo(widened, 6);
});

it("reorders with the layer menu", async () => {
  const project = fixtureProject({ texts: 0, overlays: 2 });
  const { store } = await open(project);
  const first = overlayOf(store, 0);
  const second = overlayOf(store, 1);
  expect(first.z).toBeLessThan(second.z ?? 0);

  openLayerMenu(layerElement("overlay", first.id));

  await pickMenuItem("Bring to front");

  await expect
    .poll(() => overlayOf(store, 0).z)
    .toBeGreaterThan(overlayOf(store, 1).z ?? 0);
});

it("crops with a handle drag, then applies on exit", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  const before = { ...overlayOf(store) };

  openLayerMenu(layerElement("overlay", id));
  await pickMenuItem("Crop");

  await expect.poll(() => store.getSnapshot().croppingOverlayId).toBe(id);
  const rect = await page.getByTestId("crop-rect").element();
  const handle = rect.querySelector<HTMLElement>('[data-crop-handle="e"]');
  if (handle === null) throw new Error("No east crop handle.");
  const from = centreOf(handle);

  // Half the overlay's width inwards, so the kept region is about half as wide.
  const overlayWidthPx = layerElement("overlay", id).getBoundingClientRect().width;
  drag(handle, from, { x: from.x - overlayWidthPx / 2, y: from.y });

  expect(overlayOf(store).cropW).toBeLessThan(0.6);
  expect(overlayOf(store).cropW).toBeGreaterThan(0.4);

  // A press on the workspace commits the crop and does nothing else.
  const surface = document.querySelector<HTMLElement>(
    '[data-testid="workspace-surface"]',
  );
  if (surface === null) throw new Error("No workspace surface.");
  surface.dispatchEvent(pointer("pointerdown", 4, 4));
  surface.dispatchEvent(pointer("pointerup", 4, 4));

  expect(store.getSnapshot().croppingOverlayId).toBe(null);
  // The kept half is folded back into the overlay, so it is about half as wide
  // as the whole asset was while the crop editor was open.
  expect(overlayOf(store).width).toBeLessThan(before.width);
  expect(overlayOf(store).cropW).toBeLessThan(0.6);
});

it("un-applies an existing crop when the crop editor opens, and puts it back", async () => {
  const { store } = await open(projectWithCroppedOverlay());
  const id = overlayOf(store).id;
  const before = { ...overlayOf(store) };
  expect(before.width).toBeCloseTo(0.3, 6);
  expect(before.x).toBeCloseTo(0.3, 6);

  openLayerMenu(layerElement("overlay", id));
  await pickMenuItem("Crop");
  await expect.poll(() => store.getSnapshot().croppingOverlayId).toBe(id);

  /*
   * The crop editor shows the whole asset in place, so the overlay grows to the
   * box the uncropped image would occupy and its origin moves so the visible
   * part does not shift. Half a crop doubles the box: 0.3 / 0.5.
   */
  const opened = overlayOf(store);
  expect(opened.width).toBeCloseTo(0.6, 6);
  expect(opened.height ?? 0).toBeCloseTo(0.6, 6);
  expect(opened.x).toBeCloseTo(0.15, 6);
  expect(opened.y).toBeCloseTo(0.15, 6);

  const surface = document.querySelector<HTMLElement>(
    '[data-testid="workspace-surface"]',
  );
  if (surface === null) throw new Error("No workspace surface.");
  surface.dispatchEvent(pointer("pointerdown", 4, 4));
  surface.dispatchEvent(pointer("pointerup", 4, 4));

  /*
   * And exactly back again. Any asymmetry between the two halves compounds on
   * every crop, which is what makes a round trip the thing worth asserting
   * rather than either half on its own.
   *
   * The poll is on the restored geometry itself rather than on
   * croppingOverlayId, which finish() clears *before* it restores. Waiting on
   * the earlier of two statements proves nothing about the later one, and would
   * start reading the un-restored overlay the moment an await appeared between
   * them.
   */
  await expect.poll(() => Math.round(overlayOf(store).width * 1e6)).toBe(300000);
  expect(store.getSnapshot().croppingOverlayId).toBe(null);
  const closed = overlayOf(store);
  expect(closed.width).toBeCloseTo(before.width, 6);
  expect(closed.height ?? 0).toBeCloseTo(before.height ?? 0, 6);
  expect(closed.x).toBeCloseTo(before.x, 6);
  expect(closed.y).toBeCloseTo(before.y, 6);
  expect(closed.cropW).toBeCloseTo(0.5, 6);
});

it("discards the crop when a cropping overlay is deleted", async () => {
  const { store } = await open(projectWithCroppedOverlay());
  const id = overlayOf(store).id;

  openLayerMenu(layerElement("overlay", id));
  await pickMenuItem("Crop");
  await expect.poll(() => store.getSnapshot().croppingOverlayId).toBe(id);
  // beginCrop widened the overlay to the whole asset. That geometry is what a
  // delete must never write back out.
  expect(overlayOf(store).width).toBeCloseTo(0.6, 6);

  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
  );

  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(0);
  expect(store.getSnapshot().croppingOverlayId).toBe(null);

  /*
   * The delete recorded its undo entry over the widened overlay, so undoing it
   * brings back what the reader was looking at. Applying the crop first, which
   * is the bug app.js:3467 avoids, would fold the width to 0.3 before the
   * snapshot was taken and this would restore the wrong geometry.
   */
  store.undo();
  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(1);
  expect(overlayOf(store).width).toBeCloseTo(0.6, 6);
});

it("clips the part of an overlay that hangs off the canvas", async () => {
  const { store } = await open();
  const id = overlayOf(store).id;
  store.mutate((document) => {
    const overlay = document.slides[0]?.overlays[0];
    if (overlay !== undefined) overlay.x = -0.15;
  });
  store.selectOnly("overlay", id);

  // Half the overlay is off the left edge, so half of it is clipped away.
  const inside = await page.getByTestId("overlay-inside").element();
  await expect
    .poll(() => (inside as HTMLElement).style.clipPath)
    .toBe("inset(0% 0% 0% 50%)");
  // The greyed copy of the overhang is what tells a reader the layer reaches
  // off the slide, and it appears only while the layer is selected.
  await expect
    .poll(() => stackElement().querySelectorAll('[data-visible="true"]').length)
    .toBe(1);
});
