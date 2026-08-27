import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
// The stage is laid out from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { getImageLayout } from "@shared/geometry/index.js";
import { EditorStore } from "./store.js";
import type { LibraryIndex } from "../../app/useLibrary.js";
import { fixtureProject } from "./testing.js";
import { Stage } from "./Stage.js";
import type { StageProps } from "./Stage.js";

/* A one pixel PNG, so an <img> in the stage resolves rather than logging a 404. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function backgroundItem(id: string): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: id,
    ext: "png",
    url: PIXEL,
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 1, slideshowCount: 1, firstUsedAt: 1, lastUsedAt: 1 },
  };
}

function libraryFor(project: Project): LibraryIndex {
  return new Map(
    project.slides.map((slide) => [
      slide.backgroundItemId,
      backgroundItem(slide.backgroundItemId),
    ]),
  );
}

type Harness = { store: EditorStore; library: LibraryIndex };

/*
 * `now` is a counter rather than the clock. Saver.schedule stamps
 * project.updatedAt with it on every mutate that is not marked save:false, so a
 * strictly increasing stamp turns "did the handler mutate" into an exact
 * reading, with none of the store's other publishes in the way.
 */
function harness(project: Project = fixtureProject()): Harness {
  let tick = project.updatedAt;
  const store = new EditorStore(project, {
    save: (saved) => Promise.resolve(saved),
    now: () => (tick += 1),
  });
  return { store, library: libraryFor(project) };
}

/** The stamp Saver.schedule writes, which only a mutate that ran can move. */
function writeStamp(store: EditorStore): number {
  return store.getSnapshot().project.updatedAt;
}

/**
 * The stage fills whatever box it is given, so every test hands it one. 640 by
 * 760 is wider than a 9:16 stage needs and shorter than one, which is the case
 * sizeStage has to fall back to a height fit for (app.js:2604-2607).
 */
type FrameProps = Harness & Omit<StageProps, "store" | "library">;

function Frame({ store, library, ...rest }: FrameProps) {
  return (
    <div style={{ width: "640px", height: "760px", display: "grid" }}>
      <Stage store={store} library={library} {...rest} />
    </div>
  );
}

function stageElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (element === null) throw new Error("The stage did not render.");
  return element;
}

function pointer(
  type: string,
  clientX: number,
  clientY: number,
  init: PointerEventInit = {},
) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX,
    clientY,
    ...init,
  });
}

function wheel(target: Element, init: WheelEventInit) {
  target.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }),
  );
}

/**
 * Waits until the stage has actually been measured, rather than for a fixed
 * number of frames. A ResizeObserver delivers on its own schedule, so counting
 * frames is a guess that is right on a quiet machine and wrong on a busy one.
 */
async function measured(read: () => HTMLElement = stageElement): Promise<void> {
  await vi.waitFor(() => {
    expect(read().clientWidth).toBeGreaterThan(1);
  });
}

it("sizes the stage to the slideshow ratio", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const stage = stageElement();
  // outputAspect(9:16) is 1080/1920, so height is width times 16/9.
  expect(stage.clientHeight / stage.clientWidth).toBeCloseTo(1920 / 1080, 2);
  expect(stage.clientWidth).toBeGreaterThan(0);
  // 640 by 760 is wider than a 9:16 stage needs and shorter than one, so the
  // fit has to fall back to the height and leave width on the table
  // (app.js:2604-2607). Without that fallback the stage runs off the bottom.
  expect(stage.clientHeight).toBeLessThanOrEqual(760);
  expect(stage.clientWidth).toBeLessThan(500);
  screen.unmount();
});

it("keeps the ratio when the window is narrower than the stage", async () => {
  const { store, library } = harness();
  const screen = await render(
    <div style={{ width: "200px", height: "900px", display: "grid" }}>
      <Stage store={store} library={library} />
    </div>,
  );
  await measured();

  const stage = stageElement();
  expect(stage.clientHeight / stage.clientWidth).toBeCloseTo(1920 / 1080, 2);
  // A 200px box cannot hold a 9:16 stage taller than itself, so width leads.
  expect(stage.clientWidth).toBeLessThanOrEqual(200);
  screen.unmount();
});

it("zooms on ctrl and wheel, clamped between 0.2 and 3", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const base = stageElement().clientWidth;
  const workspace = document.querySelector('[data-testid="workspace"]');
  if (workspace === null) throw new Error("The workspace did not render.");

  wheel(workspace, { deltaY: -200, ctrlKey: true, clientX: 300, clientY: 400 });
  await measured();
  expect(stageElement().clientWidth).toBeGreaterThan(base);

  // Far past the ceiling. A missing clamp would run away instead of stopping.
  for (let step = 0; step < 40; step += 1) {
    wheel(workspace, { deltaY: -400, ctrlKey: true, clientX: 300, clientY: 400 });
  }
  await measured();
  expect(stageElement().clientWidth / base).toBeCloseTo(3, 1);
  await expect
    .element(screen.getByRole("button", { name: "Reset canvas zoom" }))
    .toHaveTextContent("300%");

  for (let step = 0; step < 80; step += 1) {
    wheel(workspace, { deltaY: 400, ctrlKey: true, clientX: 300, clientY: 400 });
  }
  await measured();
  expect(stageElement().clientWidth / base).toBeCloseTo(0.2, 1);
  await expect
    .element(screen.getByRole("button", { name: "Reset canvas zoom" }))
    .toHaveTextContent("20%");
  screen.unmount();
});

it("leaves the stage alone on a wheel without a modifier", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const base = stageElement().clientWidth;
  const workspace = document.querySelector('[data-testid="workspace"]');
  if (workspace === null) throw new Error("The workspace did not render.");
  wheel(workspace, { deltaY: -400, clientX: 300, clientY: 400 });
  await measured();
  expect(stageElement().clientWidth).toBe(base);
  screen.unmount();
});

it("pans the background photo when dragged in photo mode", async () => {
  const project = fixtureProject();
  const { store, library } = harness(project);
  store.mutate((document) => {
    const slide = document.slides[0];
    if (slide) slide.imageScale = 2;
  });
  const screen = await render(<Frame store={store} library={library} photoAdjust />);
  await measured();

  const stage = stageElement();
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(
    pointer("pointerdown", rect.left + rect.width / 2, rect.top + rect.height / 2),
  );
  window.dispatchEvent(
    pointer(
      "pointermove",
      rect.left + rect.width / 2 + 40,
      rect.top + rect.height / 2 + 25,
    ),
  );
  window.dispatchEvent(
    pointer(
      "pointerup",
      rect.left + rect.width / 2 + 40,
      rect.top + rect.height / 2 + 25,
    ),
  );

  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  expect(slide.imageX).toBeCloseTo(40 / rect.width, 3);
  expect(slide.imageY).toBeCloseTo(25 / rect.height, 3);
  screen.unmount();
});

it("never lets the background leave a gap", async () => {
  const project = fixtureProject();
  const { store, library } = harness(project);
  store.mutate((document) => {
    const slide = document.slides[0];
    if (slide) slide.imageScale = 1.2;
  });
  const screen = await render(<Frame store={store} library={library} photoAdjust />);
  await measured();

  const stage = stageElement();
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(
    pointer("pointerdown", rect.left + rect.width / 2, rect.top + rect.height / 2),
  );
  // Ten stage widths of drag. Nothing may pan the photo off its own edge.
  window.dispatchEvent(
    pointer("pointermove", rect.left + rect.width * 10, rect.top + rect.height * 10),
  );
  window.dispatchEvent(
    pointer("pointerup", rect.left + rect.width * 10, rect.top + rect.height * 10),
  );

  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  const layout = getImageLayout(slide, rect.width, rect.height);
  expect(layout.maxOffsetX).toBeGreaterThan(0);
  expect(slide.imageX).toBeCloseTo(layout.maxOffsetX, 5);
  expect(layout.left).toBeLessThanOrEqual(0);
  expect(layout.left + layout.width).toBeGreaterThanOrEqual(rect.width - 0.001);
  screen.unmount();
});

it("clears the layer selection when the stage background is clicked", async () => {
  const { store, library } = harness();
  store.selectOnly("text", "text-1-1");
  expect(store.getSnapshot().selection).toEqual(["text:text-1-1"]);

  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const surface = document.querySelector('[data-testid="workspace-surface"]');
  if (surface === null) throw new Error("The workspace surface did not render.");
  const rect = surface.getBoundingClientRect();
  surface.dispatchEvent(pointer("pointerdown", rect.left + 3, rect.top + 3));
  window.dispatchEvent(pointer("pointerup", rect.left + 3, rect.top + 3));

  expect(store.getSnapshot().selection).toEqual([]);
  screen.unmount();
});

it("selects several layers with a marquee drag", async () => {
  // setLayerSelection drops a key no layer answers to, so the fixture has to
  // hold every layer the marquee is meant to catch.
  const { store, library } = harness(fixtureProject({ texts: 2, overlays: 1 }));
  const screen = await render(
    <Frame store={store} library={library}>
      <div
        data-layer-kind="text"
        data-layer-id="text-1-1"
        style={{
          position: "absolute",
          left: "4px",
          top: "4px",
          width: "20px",
          height: "20px",
        }}
      />
      <div
        data-layer-kind="overlay"
        data-layer-id="overlay-1-1"
        style={{
          position: "absolute",
          left: "4px",
          top: "40px",
          width: "20px",
          height: "20px",
        }}
      />
      <div
        data-layer-kind="text"
        data-layer-id="text-1-2"
        style={{
          position: "absolute",
          right: "4px",
          bottom: "4px",
          width: "20px",
          height: "20px",
        }}
      />
    </Frame>,
  );
  await measured();

  const surface = document.querySelector('[data-testid="workspace-surface"]');
  if (surface === null) throw new Error("The workspace surface did not render.");
  const start = surface.getBoundingClientRect();
  const stage = stageElement().getBoundingClientRect();

  surface.dispatchEvent(pointer("pointerdown", start.left + 2, start.top + 2));
  window.dispatchEvent(pointer("pointermove", stage.left + 30, stage.top + 70));
  window.dispatchEvent(pointer("pointerup", stage.left + 30, stage.top + 70));

  // The two boxes near the frame's top left, and not the one at its bottom right.
  expect([...store.getSnapshot().selection].sort()).toEqual([
    "overlay:overlay-1-1",
    "text:text-1-1",
  ]);
  screen.unmount();
});

it("keeps the selection a plain click made when the marquee never moves", async () => {
  const { store, library } = harness();
  store.selectOnly("text", "text-1-1");
  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const surface = document.querySelector('[data-testid="workspace-surface"]');
  if (surface === null) throw new Error("The workspace surface did not render.");
  const rect = surface.getBoundingClientRect();
  // Two pixels, under the three pixel threshold at app.js:2551.
  surface.dispatchEvent(
    pointer("pointerdown", rect.left + 3, rect.top + 3, { metaKey: true }),
  );
  window.dispatchEvent(
    pointer("pointermove", rect.left + 5, rect.top + 3, { metaKey: true }),
  );
  window.dispatchEvent(
    pointer("pointerup", rect.left + 5, rect.top + 3, { metaKey: true }),
  );

  // A meta click that never moved restores what was selected before it.
  expect(store.getSnapshot().selection).toEqual(["text:text-1-1"]);
  screen.unmount();
});

it("zooms the background photo on a plain wheel in photo mode", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} photoAdjust />);
  await measured();

  const stage = stageElement();
  const rect = stage.getBoundingClientRect();
  wheel(stage, {
    deltaY: -240,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  });

  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  expect(slide.imageScale).toBeGreaterThan(1);

  // Far past the photo's own ceiling of 3 (PHOTO_ZOOM_MAX), which is a
  // different band from the viewport's.
  for (let step = 0; step < 40; step += 1) {
    wheel(stage, { deltaY: -400, clientX: rect.left + 10, clientY: rect.top + 10 });
  }
  expect(slide.imageScale).toBe(3);

  for (let step = 0; step < 80; step += 1) {
    wheel(stage, { deltaY: 400, clientX: rect.left + 10, clientY: rect.top + 10 });
  }
  // One means cover, and no less: below it the photo would leave a gap.
  expect(slide.imageScale).toBe(1);

  /*
   * And at the rail it stops working, rather than rewriting the same number.
   * app.js:2280 compares the *clamped* scale against the current one, so a
   * wheel that cannot move the photo any further does not mutate, does not
   * schedule a save, and does not eventually open an undo entry that undoes
   * nothing. Clamping only inside zoomPhotoAtPoint would leave that guard
   * comparing 3.2 against 3 and doing the work every time.
   */
  // Nothing left owing, so no debounced write can land in the reading below.
  await store.flush();
  const before = writeStamp(store);
  for (let step = 0; step < 5; step += 1) {
    wheel(stage, { deltaY: 400, clientX: rect.left + 10, clientY: rect.top + 10 });
  }
  // The stamp is untouched, so not one of those five wheels reached mutate.
  // Counting store publishes here instead reads the saver's own three as well,
  // which is a different question and a flaky answer to this one.
  expect(writeStamp(store)).toBe(before);

  // And the reading is live: a wheel that can still move the photo moves it.
  wheel(stage, { deltaY: -240, clientX: rect.left + 10, clientY: rect.top + 10 });
  expect(writeStamp(store)).toBeGreaterThan(before);
  screen.unmount();
});

it("makes a whole wheel burst one undo step", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} photoAdjust />);
  await measured();

  const stage = stageElement();
  const rect = stage.getBoundingClientRect();
  for (let step = 0; step < 8; step += 1) {
    wheel(stage, {
      deltaY: -120,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  }
  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  expect(slide.imageScale).toBeGreaterThan(1);

  // app.js:2281-2286 holds one history entry open behind a trailing timer, so a
  // scroll burst backs out in one press rather than eight.
  store.undo();
  expect(store.getSnapshot().project.slides[0]?.imageScale).toBe(1);
  expect(store.canUndo()).toBe(false);
  screen.unmount();
});

it("makes a photo drag undoable in one step", async () => {
  const project = fixtureProject();
  const { store, library } = harness(project);
  // Set up without an undo entry of its own. With one, an undo after the drag
  // would land on this snapshot and the test would pass on a drag that recorded
  // nothing at all.
  store.mutate(
    (document) => {
      const slide = document.slides[0];
      if (slide) slide.imageScale = 2;
    },
    { history: false },
  );
  expect(store.canUndo()).toBe(false);
  const screen = await render(<Frame store={store} library={library} photoAdjust />);
  await measured();

  const stage = stageElement();
  const rect = stage.getBoundingClientRect();
  const centreX = rect.left + rect.width / 2;
  const centreY = rect.top + rect.height / 2;
  stage.dispatchEvent(pointer("pointerdown", centreX, centreY));
  // Several moves. app.js:4096 records once at pointer down, so the whole drag
  // is one entry however many frames it took.
  window.dispatchEvent(pointer("pointermove", centreX + 10, centreY));
  window.dispatchEvent(pointer("pointermove", centreX + 25, centreY + 5));
  window.dispatchEvent(pointer("pointermove", centreX + 40, centreY + 25));
  window.dispatchEvent(pointer("pointerup", centreX + 40, centreY + 25));
  expect(store.getSnapshot().project.slides[0]?.imageX).toBeGreaterThan(0);
  // app.js:4096 records at pointer down. Without that entry the drag cannot be
  // backed out at all, which is what this asserts before it undoes anything.
  expect(store.canUndo()).toBe(true);

  store.undo();
  expect(store.getSnapshot().project.slides[0]?.imageX).toBe(0);
  expect(store.getSnapshot().project.slides[0]?.imageY).toBe(0);
  // One entry for the whole drag, not one per pointermove.
  expect(store.canUndo()).toBe(false);
  screen.unmount();
});

it("leaves the actions column out of the space the stage may use", async () => {
  const bare = harness();
  const withColumn = harness();
  // Two identical boxes side by side, one stage with a toolbar and one without.
  // Tall and narrow, so width is what binds: in a short wide box the height
  // fallback decides the size and the toolbar could be any width at all.
  const screen = await render(
    <>
      <div
        data-testid="bare"
        style={{ width: "400px", height: "900px", display: "grid" }}
      >
        <Stage store={bare.store} library={bare.library} />
      </div>
      <div
        data-testid="with-column"
        style={{ width: "400px", height: "900px", display: "grid" }}
      >
        <Stage
          store={withColumn.store}
          library={withColumn.library}
          actions={<div style={{ width: "132px" }}>Tools</div>}
        />
      </div>
    </>,
  );
  const stageIn = (box: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(
      `[data-testid="${box}"] [data-testid="stage"]`,
    );
    if (element === null) throw new Error(`No stage in ${box}.`);
    return element;
  };
  // Both, because the comparison is meaningless until each has been measured.
  await measured(() => stageIn("bare"));
  await measured(() => stageIn("with-column"));

  const column = document.querySelector<HTMLElement>("[data-canvas-actions]");
  if (column === null) throw new Error("The actions column did not render.");
  const composition = column.parentElement;
  if (composition === null) throw new Error("The actions column has no row.");
  const gap = parseFloat(getComputedStyle(composition).columnGap) || 0;
  expect(gap).toBeGreaterThan(0);

  // app.js:2595-2599 subtracts both the column and the gap beside it. Missing
  // either one puts the stage under the toolbar; subtracting the gap when there
  // is no column steals it from a stage that has nothing to sit beside.
  const shrunk =
    stageIn("bare").getBoundingClientRect().width -
    stageIn("with-column").getBoundingClientRect().width;
  expect(shrunk).toBeCloseTo(column.offsetWidth + gap, 0);
  screen.unmount();
});

it("does not marquee from a press on a control or a layer", async () => {
  const { store, library } = harness(fixtureProject({ texts: 1, overlays: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await render(
    <Frame store={store} library={library} actions={<button type="button">Text</button>}>
      <div
        data-layer-kind="overlay"
        data-layer-id="overlay-1-1"
        style={{
          position: "absolute",
          left: "4px",
          top: "4px",
          width: "20px",
          height: "20px",
        }}
      />
    </Frame>,
  );
  await measured();

  const button = document.querySelector("[data-canvas-actions] button");
  const column = document.querySelector<HTMLElement>("[data-canvas-actions]");
  const layer = document.querySelector("[data-layer-kind]");
  if (button === null || column === null || layer === null) {
    throw new Error("The stage did not render its controls.");
  }

  for (const target of [button, column, layer]) {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(pointer("pointerdown", rect.left + 1, rect.top + 1));
    window.dispatchEvent(pointer("pointerup", rect.left + 1, rect.top + 1));
    // app.js:2222 hands the press to the control. A marquee starting here would
    // wipe the selection the inspector is showing.
    expect(store.getSnapshot().selection).toEqual(["text:text-1-1"]);
  }
  screen.unmount();
});

it("commits a crop on the first click instead of deselecting", async () => {
  const { store, library } = harness(fixtureProject({ texts: 1, overlays: 1 }));
  store.selectOnly("overlay", "overlay-1-1");
  store.setCropping("overlay-1-1");
  let finished = 0;
  const screen = await render(
    <Frame
      store={store}
      library={library}
      onFinishCrop={() => {
        finished += 1;
      }}
    />,
  );
  await measured();

  const surface = document.querySelector('[data-testid="workspace-surface"]');
  if (surface === null) throw new Error("The workspace surface did not render.");
  const rect = surface.getBoundingClientRect();
  surface.dispatchEvent(pointer("pointerdown", rect.left + 3, rect.top + 3));
  window.dispatchEvent(pointer("pointerup", rect.left + 3, rect.top + 3));

  // app.js:2299-2306. The click commits the crop and does nothing else, because
  // folding it back needs the asset's pixel size the stage does not hold.
  expect(finished).toBe(1);
  expect(store.getSnapshot().selection).toEqual(["overlay:overlay-1-1"]);
  screen.unmount();
});

it("steps the viewport zoom from the buttons and resets it", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} />);
  await measured();
  const base = stageElement().clientWidth;
  const readout = screen.getByRole("button", { name: "Reset canvas zoom" });

  // app.js:2209-2211 steps by 1.2 either way and resets to 1.
  await userEvent.click(screen.getByRole("button", { name: "Zoom canvas in" }));
  await expect.element(readout).toHaveTextContent("120%");
  expect(stageElement().clientWidth).toBeGreaterThan(base);

  await userEvent.click(screen.getByRole("button", { name: "Zoom canvas out" }));
  await expect.element(readout).toHaveTextContent("100%");

  await userEvent.click(screen.getByRole("button", { name: "Zoom canvas out" }));
  await expect.element(readout).toHaveTextContent("83%");
  expect(stageElement().clientWidth).toBeLessThan(base);

  await userEvent.click(readout);
  await expect.element(readout).toHaveTextContent("100%");
  expect(stageElement().clientWidth).toBeCloseTo(base, 0);
  screen.unmount();
});

it("shows the full photo behind the frame only while it is being placed", async () => {
  const { store, library } = harness();
  const screen = await render(<Frame store={store} library={library} />);
  await measured();

  const ghost = () => {
    const images = [...document.querySelectorAll<HTMLImageElement>("img")];
    return images.find((image) => image.getAttribute("aria-hidden") === "true") ?? null;
  };
  const shown = () => {
    const element = ghost();
    return element === null ? "none" : getComputedStyle(element).display;
  };
  // styles.css:986-999. Out of the way until the reader is placing the photo,
  // then behind the frame so they can see what is cropped off.
  expect(shown()).toBe("none");

  screen.rerender(<Frame store={store} library={library} photoAdjust />);
  await vi.waitFor(() => {
    expect(shown()).toBe("block");
  });
  screen.unmount();
});

it("needs more than a few pixels of drag before it marquees", async () => {
  const { store, library } = harness(fixtureProject({ texts: 1, overlays: 1 }));
  const screen = await render(
    <Frame store={store} library={library}>
      <div
        data-layer-kind="overlay"
        data-layer-id="overlay-1-1"
        style={{
          position: "absolute",
          left: "0",
          top: "0",
          width: "40px",
          height: "40px",
        }}
      />
    </Frame>,
  );
  await measured();

  const surface = document.querySelector('[data-testid="workspace-surface"]');
  if (surface === null) throw new Error("The workspace surface did not render.");
  const stage = stageElement().getBoundingClientRect();

  /*
   * Starting one pixel outside the layer's corner and travelling two pixels
   * diagonally into it. The band this sweeps does overlap the layer, so a
   * threshold of zero would select it; app.js:2551 wants more than three pixels
   * before a press counts as a drag, so that a plain click on empty canvas
   * deselects instead of marquee-selecting whatever it happens to touch.
   */
  surface.dispatchEvent(pointer("pointerdown", stage.left - 1, stage.top - 1));
  window.dispatchEvent(pointer("pointermove", stage.left + 1, stage.top + 1));
  window.dispatchEvent(pointer("pointerup", stage.left + 1, stage.top + 1));
  expect(store.getSnapshot().selection).toEqual([]);

  // The same gesture, past the threshold, does select it. Without this the test
  // above would pass on a marquee that never selects anything at all.
  surface.dispatchEvent(pointer("pointerdown", stage.left - 1, stage.top - 1));
  window.dispatchEvent(pointer("pointermove", stage.left + 10, stage.top + 10));
  window.dispatchEvent(pointer("pointerup", stage.left + 10, stage.top + 10));
  expect(store.getSnapshot().selection).toEqual(["overlay:overlay-1-1"]);
  screen.unmount();
});
