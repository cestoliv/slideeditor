import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { LibraryItem } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import {
  ASSET_DRAG_PREFIX,
  ASSET_DRAG_TYPE,
  STAGE_DROP_ATTRIBUTE,
  assetDragProps,
} from "./useAssetDrop.js";
import {
  LayerHarness,
  editorStore,
  libraryFor,
  libraryItem,
  measuredStage,
  stackElement,
} from "./testing.js";

/*
 * Dropping an asset or an image file on the canvas. Ported behaviour from
 * bindStageAssetDrop (app.js:3255-3281) and addDroppedAssetsToSlide
 * (app.js:3332-3369).
 */

async function open(upload?: (file: File, name: string) => Promise<LibraryItem>) {
  const project = fixtureProject({ slides: 1, texts: 0, overlays: 0 });
  const store = editorStore(project);
  const library = new Map(libraryFor(project));
  library.set("asset-1", libraryItem("asset-1", 600, 300, "Sticker"));
  const toasts: string[] = [];
  await render(
    <LayerHarness
      store={store}
      library={library}
      upload={upload}
      toast={(message) => toasts.push(message)}
    />,
  );
  await measuredStage();
  return { store, toasts };
}

function dropAt(type: string, transfer: DataTransfer, clientX: number, clientY: number) {
  document.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX,
      clientY,
    }),
  );
}

it("writes the payload the stage reads back", () => {
  const transfer = new DataTransfer();
  const props = assetDragProps("asset-1");
  props.onDragStart({ dataTransfer: transfer } as unknown as never);

  expect(transfer.getData(ASSET_DRAG_TYPE)).toBe("asset-1");
  // The plain text fallback is what survives a drag into another application.
  expect(transfer.getData("text/plain")).toBe(`${ASSET_DRAG_PREFIX}asset-1`);
});

it("adds an overlay where an asset is dropped on the stage", async () => {
  const { store } = await open();
  const rect = stackElement().getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.setData(ASSET_DRAG_TYPE, "asset-1");

  dropAt("drop", transfer, rect.left + rect.width * 0.25, rect.top + rect.height * 0.75);

  const overlays = store.getSnapshot().project.slides[0]?.overlays ?? [];
  expect(overlays).toHaveLength(1);
  const overlay = overlays[0];
  if (overlay === undefined) throw new Error("Nothing was dropped.");
  // The drop point is the overlay's centre, not its corner.
  expect(overlay.x + overlay.width / 2).toBeCloseTo(0.25, 2);
  expect(store.getSnapshot().selection).toEqual([`overlay:${overlay.id}`]);
});

it("ignores an asset dropped outside the canvas", async () => {
  const { store } = await open();
  const transfer = new DataTransfer();
  transfer.setData(ASSET_DRAG_TYPE, "asset-1");

  dropAt("drop", transfer, 2, 2);

  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(0);
});

it("says so when the dropped asset is not in the library", async () => {
  const { store, toasts } = await open();
  const rect = stackElement().getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.setData(ASSET_DRAG_TYPE, "not-there");

  dropAt("drop", transfer, rect.left + rect.width / 2, rect.top + rect.height / 2);

  expect(store.getSnapshot().project.slides[0]?.overlays).toHaveLength(0);
  expect(toasts).toContain("That asset is missing.");
});

it("uploads image files dropped on the canvas and places them", async () => {
  const first = libraryItem("dropped-1", 400, 400, "Dropped image 1");
  const second = libraryItem("dropped-2", 400, 400, "Dropped image 2");
  const upload = vi
    .fn<(file: File, name: string) => Promise<LibraryItem>>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const { store } = await open(upload);
  const rect = stackElement().getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.items.add(new File(["a"], "one.png", { type: "image/png" }));
  transfer.items.add(new File(["b"], "two.png", { type: "image/png" }));

  dropAt("drop", transfer, rect.left + rect.width / 2, rect.top + rect.height / 2);

  await expect.poll(() => store.getSnapshot().project.slides[0]?.overlays.length).toBe(2);
  expect(upload).toHaveBeenCalledTimes(2);
  const overlays = store.getSnapshot().project.slides[0]?.overlays ?? [];
  // Each image lands a little below the last, so the second is not hidden by
  // the first (app.js:3364).
  expect(overlays[1]?.x).toBeGreaterThan(overlays[0]?.x ?? 0);
});

it("marks the canvas while an asset drag is over it", async () => {
  await open();
  const rect = stackElement().getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.setData(ASSET_DRAG_TYPE, "asset-1");

  dropAt("dragover", transfer, rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(stackElement().hasAttribute(STAGE_DROP_ATTRIBUTE)).toBe(true);

  dropAt("dragover", transfer, 2, 2);
  expect(stackElement().hasAttribute(STAGE_DROP_ATTRIBUTE)).toBe(false);
});
