import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { fixtureProject } from "../testing.js";
import type { EditorStore } from "../store.js";
import { useLayerDrag } from "./useLayerDrag.js";
import type { DragDelta } from "./useLayerDrag.js";
import { editorStore, pointer } from "./testing.js";

/*
 * The gesture mechanism on its own: the undo entry it opens, the pointer it
 * captures, and the listeners it takes back.
 */

type Recorded = { delta: DragDelta; event: PointerEvent };

function Subject({
  store,
  moves,
  ends,
  record,
}: {
  store: EditorStore;
  moves: Recorded[];
  ends: PointerEvent[];
  record?: boolean | undefined;
}) {
  const onPointerDown = useLayerDrag({
    store,
    record,
    onMove: (delta, event) => {
      moves.push({ delta, event });
    },
    onEnd: (event) => {
      ends.push(event);
    },
  });
  return (
    <div
      data-testid="subject"
      style={{ width: "200px", height: "200px", background: "#ccc" }}
      onPointerDown={onPointerDown}
    />
  );
}

async function mount(options: { record?: boolean } = {}) {
  const store = editorStore(fixtureProject({ texts: 1 }));
  const moves: Recorded[] = [];
  const ends: PointerEvent[] = [];
  await render(
    <Subject store={store} moves={moves} ends={ends} record={options.record} />,
  );
  const element = document.querySelector<HTMLElement>('[data-testid="subject"]');
  if (element === null) throw new Error("The subject did not render.");
  return { store, moves, ends, element };
}

it("reports the pointer's travel since the press", async () => {
  const { moves, element } = await mount();

  element.dispatchEvent(pointer("pointerdown", 100, 100));
  element.dispatchEvent(pointer("pointermove", 130, 80));
  element.dispatchEvent(pointer("pointermove", 90, 140));
  element.dispatchEvent(pointer("pointerup", 90, 140));

  expect(moves.map((entry) => entry.delta)).toEqual([
    { dx: 30, dy: -20 },
    { dx: -10, dy: 40 },
  ]);
});

it("opens one undo entry for the whole gesture", async () => {
  const { store, element } = await mount();
  const text = store.getSnapshot().project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  const before = text.x;

  element.dispatchEvent(pointer("pointerdown", 0, 0));
  for (let step = 1; step <= 10; step += 1) {
    // The caller's own writes ride the entry the press opened.
    store.mutate(
      (document) => {
        const live = document.slides[0]?.texts[0];
        if (live !== undefined) live.x = before + step * 0.01;
      },
      { history: false },
    );
    element.dispatchEvent(pointer("pointermove", step, step));
  }
  element.dispatchEvent(pointer("pointerup", 10, 10));

  store.undo();

  expect(store.getSnapshot().project.slides[0]?.texts[0]?.x).toBeCloseTo(before, 6);
  expect(store.canUndo()).toBe(false);
});

it("opens no undo entry when the gesture records nothing", async () => {
  const { store, element } = await mount({ record: false });

  element.dispatchEvent(pointer("pointerdown", 0, 0));
  element.dispatchEvent(pointer("pointerup", 0, 0));

  // beginCropMove (app.js:3689) is the one gesture that records nothing, so
  // there is nothing for an undo to take back.
  expect(store.canUndo()).toBe(false);
});

it("listens on the element once the capture is taken", async () => {
  const { moves, element } = await mount();
  const capture = vi.spyOn(element, "setPointerCapture");

  element.dispatchEvent(pointer("pointerdown", 10, 10));
  /*
   * A move that does not bubble, so only a listener on the element itself can
   * see it. That is the whole mechanism: the capture is taken so the browser
   * retargets the rest of the gesture to this element, and the gesture listens
   * there rather than on window the way app.js:3969-4017 had to.
   *
   * Chromium takes the capture here — measured, seven gestures out of seven —
   * so this is the branch the suite runs by default.
   */
  element.dispatchEvent(pointer("pointermove", 4000, -4000, { bubbles: false }));
  element.dispatchEvent(pointer("pointerup", 4000, -4000));

  expect(capture).toHaveBeenCalledWith(1);
  expect(moves).toHaveLength(1);
  expect(moves[0]?.delta).toEqual({ dx: 3990, dy: -4010 });
});

it("tracks on window when the capture is refused", async () => {
  const { moves, ends, element } = await mount();
  // A bare spy stubs the method into succeeding, which would put the gesture
  // back on the branch above. Refusing is the case this test exists for.
  vi.spyOn(element, "setPointerCapture").mockImplementation(() => {
    throw new Error("refused");
  });

  element.dispatchEvent(pointer("pointerdown", 10, 10));
  // Dispatched where the element is not on the propagation path, so nothing but
  // a window listener can deliver it (app.js:3979's own fallback).
  document.body.dispatchEvent(pointer("pointermove", 4000, -4000));
  document.body.dispatchEvent(pointer("pointerup", 4000, -4000));

  expect(moves).toHaveLength(1);
  expect(moves[0]?.delta).toEqual({ dx: 3990, dy: -4010 });
  expect(ends).toHaveLength(1);
});

it("stops tracking after the release", async () => {
  const { moves, ends, element } = await mount();

  element.dispatchEvent(pointer("pointerdown", 0, 0));
  element.dispatchEvent(pointer("pointerup", 5, 5));
  element.dispatchEvent(pointer("pointermove", 60, 60));

  expect(ends).toHaveLength(1);
  expect(moves).toHaveLength(0);
});

it("stops tracking when the gesture is cancelled", async () => {
  const { moves, ends, element } = await mount();

  element.dispatchEvent(pointer("pointerdown", 0, 0));
  element.dispatchEvent(pointer("pointercancel", 0, 0));
  element.dispatchEvent(pointer("pointermove", 60, 60));

  // Dropping the pointercancel teardown leaks a listener per touch gesture,
  // which is why app.js:3660 binds all three.
  expect(ends).toHaveLength(1);
  expect(moves).toHaveLength(0);
});

it("ignores a second pointer's events", async () => {
  const { moves, ends, element } = await mount();

  element.dispatchEvent(pointer("pointerdown", 0, 0));
  element.dispatchEvent(pointer("pointermove", 20, 20, { pointerId: 2 }));
  element.dispatchEvent(pointer("pointerup", 20, 20, { pointerId: 2 }));

  expect(moves).toHaveLength(0);
  expect(ends).toHaveLength(0);
});

it("starts nothing on a non-primary button", async () => {
  const { store, moves, element } = await mount();

  element.dispatchEvent(pointer("pointerdown", 0, 0, { button: 2 }));
  element.dispatchEvent(pointer("pointermove", 40, 40));

  expect(moves).toHaveLength(0);
  expect(store.canUndo()).toBe(false);
});
