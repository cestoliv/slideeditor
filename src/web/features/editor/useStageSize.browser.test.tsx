import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
// The stage is laid out from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../app/useLibrary.js";
import { EditorStore } from "./store.js";
import { fixtureProject } from "./testing.js";
import { Stage } from "./Stage.js";

/*
 * The measuring contract, in a file of its own on purpose. Stage's own suite
 * mounts and tears down twenty stages before it gets here, and the resize
 * traffic that leaves behind wakes the observer for reasons that have nothing
 * to do with what is being tested: the same assertion passes there against a
 * hook that has stopped watching the row entirely. A clean page is what makes
 * it discriminate.
 */

/* A one pixel PNG, so an <img> in the stage resolves rather than logging a 404. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function library(): LibraryIndex {
  const item: LibraryItem = {
    id: "item-1",
    kind: "background",
    name: "item-1",
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: "item-1",
    ext: "png",
    url: PIXEL,
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
  return new Map([["item-1", item]]);
}

/** Tall and narrow, so the width is what binds and the column can be felt. */
const BOX = { width: "400px", height: "900px", display: "grid" } as const;

function stageWidth(): number {
  const element = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (element === null) throw new Error("The stage did not render.");
  return element.getBoundingClientRect().width;
}

it("makes room when the actions column arrives after the first measurement", async () => {
  const project = fixtureProject();
  const store = new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
  const items = library();

  const screen = await render(
    <div style={BOX}>
      <Stage store={store} library={items} />
    </div>,
  );
  await vi.waitFor(() => {
    expect(stageWidth()).toBeGreaterThan(1);
  });
  const alone = stageWidth();

  /*
   * The slot is empty on the first measurement and filled afterwards, which is
   * exactly how Tasks 15 and 16 arrive. Nothing about the workspace's own box
   * changes when the column appears, so only watching the row it lands in can
   * notice: without that the stage keeps the width it had and the two overlap,
   * silently and with no test to say so.
   */
  screen.rerender(
    <div style={BOX}>
      <Stage
        store={store}
        library={items}
        actions={<div style={{ width: "132px" }}>Tools</div>}
      />
    </div>,
  );
  await vi.waitFor(() => {
    expect(stageWidth()).toBeLessThan(alone);
  });

  const column = document.querySelector<HTMLElement>("[data-canvas-actions]");
  if (column === null) throw new Error("The actions column did not render.");
  const composition = column.parentElement;
  if (composition === null) throw new Error("The actions column has no row.");
  const gap = parseFloat(getComputedStyle(composition).columnGap) || 0;
  expect(gap).toBeGreaterThan(0);
  // Both the column and the gap beside it, the way app.js:2595-2599 subtracted them.
  expect(alone - stageWidth()).toBeCloseTo(column.offsetWidth + gap, 0);
  screen.unmount();
});
