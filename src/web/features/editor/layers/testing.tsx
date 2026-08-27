import { expect } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import type { ReactNode } from "react";
import { BUILTIN_DEFAULTS, DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { AccountDefaults, LibraryItem, Project } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { EditorStore } from "../store.js";
import { Stage } from "../Stage.js";
import { useLayerStack } from "./LayerStack.js";
import type { LayerStackOptions } from "./LayerStack.js";

/*
 * The harness the layer tests render. It is the real composition the editor
 * will use: Stage holding the layer stack, with onFinishCrop wired from the
 * same hook, so a test exercises the wiring rather than a stand-in for it.
 */

/** A one pixel PNG, so an <img> resolves rather than logging a 404. */
export const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function libraryItem(
  id: string,
  width = 1080,
  height = 1080,
  name = id,
): LibraryItem {
  return {
    id,
    kind: "background",
    name,
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: id,
    ext: "png",
    url: PIXEL,
    width,
    height,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 1, slideshowCount: 1, firstUsedAt: 1, lastUsedAt: 1 },
  };
}

export function libraryFor(project: Project, width = 1080, height = 1080): LibraryIndex {
  const items = new Map<string, LibraryItem>();
  for (const slide of project.slides) {
    items.set(slide.backgroundItemId, libraryItem(slide.backgroundItemId, width, height));
    for (const overlay of slide.overlays) {
      items.set(overlay.itemId, libraryItem(overlay.itemId, width, height));
    }
  }
  return items;
}

export function editorStore(project: Project): EditorStore {
  return new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
}

export type HarnessProps = Omit<LayerStackOptions, "library" | "defaults"> & {
  library: LibraryIndex;
  /** Rendered beside the stage, for the tests that need a drop target. */
  extras?: ReactNode;
  /** Defaults to BUILTIN_DEFAULTS; only a test about a specific account overrides it. */
  defaults?: AccountDefaults;
};

export function LayerHarness({ library, extras, defaults, ...options }: HarnessProps) {
  const { layers, onFinishCrop } = useLayerStack({
    ...options,
    library,
    defaults: defaults ?? BUILTIN_DEFAULTS,
  });
  return (
    <div style={{ width: "640px", height: "760px", display: "grid" }}>
      <Stage
        store={options.store}
        library={library}
        photoAdjust={options.photoAdjust ?? false}
        onFinishCrop={onFinishCrop}
      >
        {layers}
      </Stage>
      {extras}
    </div>
  );
}

/** One synthetic pointer event. Capture is refused for these, so the drag falls
 * back to window tracking exactly as app.js:3979 does. */
export function pointer(
  type: string,
  clientX: number,
  clientY: number,
  init: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX,
    clientY,
    ...init,
  });
}

export type Point = { x: number; y: number };

/** Presses, moves and releases, the three events every gesture listens for. */
export function drag(
  element: Element,
  from: Point,
  to: Point,
  init: PointerEventInit = {},
): void {
  element.dispatchEvent(pointer("pointerdown", from.x, from.y, init));
  element.dispatchEvent(pointer("pointermove", to.x, to.y, init));
  element.dispatchEvent(pointer("pointerup", to.x, to.y, init));
}

export function press(element: Element, at: Point, init: PointerEventInit = {}): void {
  element.dispatchEvent(pointer("pointerdown", at.x, at.y, init));
  element.dispatchEvent(pointer("pointerup", at.x, at.y, init));
}

export function stageElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (element === null) throw new Error("The stage did not render.");
  return element;
}

export function layerElement(kind: "overlay" | "text", id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-layer-kind="${kind}"][data-layer-id="${id}"]`,
  );
  if (element === null) throw new Error(`No ${kind} box for ${id}.`);
  return element;
}

/** The centre of a layer's box, in client coordinates. */
export function centreOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Opens a layer's context menu, the way a right click does.
 *
 * Radix anchors the menu at the pointer, and the test iframe is short enough
 * that the menu often lands above the viewport, where Playwright's own click
 * cannot reach it. Locating the row by its accessible name and clicking it is
 * the same event the user's click produces; only the pointer travel is missing.
 */
export function openLayerMenu(element: Element, at = centreOf(element)): void {
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

/**
 * Picks a menu row the way a reader does: a real left click.
 *
 * A raw `element.click()` would skip the pointer sequence entirely, which is
 * what hid the marquee capture that made these rows unpickable. The poll is on
 * the panel's own box, because Radix positions it in an effect and it sits
 * off-screen for a frame; clicking before it settles clicks empty space.
 */
export async function pickMenuItem(name: string): Promise<void> {
  const row = page.getByRole("menuitem", { name });
  await expect.element(row).toBeVisible();
  const item = await row.element();
  await expect.poll(() => item.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  await userEvent.click(row);
}

export function stackElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
  if (element === null) throw new Error("The layer stack did not render.");
  return element;
}

/**
 * Waits for the stage measurement the gestures divide by.
 *
 * Nothing here waits on the clock. The stack publishes the width and height its
 * ResizeObserver delivered, and the poll below is on that number, so a test
 * proceeds when the measurement exists rather than when a timer says it might.
 */
export async function measuredStage(): Promise<{ width: number; height: number }> {
  await expect
    .poll(() => Number(stackElement().dataset["stageWidth"] ?? 0))
    .toBeGreaterThan(0);
  const element = stackElement();
  return {
    width: Number(element.dataset["stageWidth"] ?? 0),
    height: Number(element.dataset["stageHeight"] ?? 0),
  };
}
