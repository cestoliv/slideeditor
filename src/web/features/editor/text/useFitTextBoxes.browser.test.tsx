import { beforeAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../../../design/fonts.css";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import { textFontString } from "@shared/text/index.js";
import type { Project } from "@shared/schema/index.js";
import { SAVE_DEBOUNCE_MS } from "../persistence.js";
import { EditorStore } from "../store.js";
import { fixtureProject } from "../testing.js";
import { useFitTextBoxes } from "./useFitTextBoxes.js";
import { layoutAt } from "./useTextLayout.js";

// A cold fetch of the face can outlast waitFor's default second on a loaded
// machine, so the file is in hand before any test starts its clock.
beforeAll(async () => {
  await document.fonts.load(textFontString(48, "TikTok Sans"));
});

function Fit({ store }: { store: EditorStore }) {
  useFitTextBoxes(store);
  return null;
}

const LONG =
  "A caption an agent composed a box too short for, long enough to wrap onto several lines";

const save = vi.fn((saved: Project) => Promise.resolve(saved));

function storeWith(texts: string[]): EditorStore {
  const project = fixtureProject({
    slides: [{}, { texts: texts.map((text) => ({ text })) }],
  });
  save.mockClear();
  return new EditorStore(project, { save });
}

function textsOf(store: EditorStore) {
  return store.getSnapshot().project.slides[1]?.texts ?? [];
}

it("grows a box that drops lines on a slide that is not open", async () => {
  const store = storeWith([LONG.repeat(3)]);
  const canvas = { width: OUTPUT_WIDTH, height: outputHeight({ w: 9, h: 16 }) };
  const screen = await render(<Fit store={store} />);

  await vi.waitFor(() => {
    expect(textsOf(store)[0]?.height).toBeGreaterThan(0.1);
  });
  const text = textsOf(store)[0];
  if (text === undefined) throw new Error("no text");
  const layout = layoutAt(text, canvas);
  expect(layout.lines).toHaveLength(layout.totalLineCount);
  expect(layout.totalLineCount).toBeGreaterThan(1);
  await screen.unmount();
});

it("grows a box without saving, so no version is written and no human edit counted", async () => {
  const store = storeWith([LONG.repeat(3)]);
  const screen = await render(<Fit store={store} />);

  await vi.waitFor(() => {
    expect(textsOf(store)[0]?.height).toBeGreaterThan(0.1);
  });
  await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS * 2));
  expect(save).not.toHaveBeenCalled();
  expect(store.getSnapshot().saveState).toBe("idle");
  await screen.unmount();
});

it("grows past the whole canvas when the text needs it", async () => {
  const store = storeWith([LONG.repeat(20)]);
  const screen = await render(<Fit store={store} />);

  await vi.waitFor(() => {
    expect(textsOf(store)[0]?.height).toBeGreaterThan(1);
  });
  await screen.unmount();
});

it("leaves a box that already fits untouched", async () => {
  const store = storeWith(["Short"]);
  const mutate = vi.spyOn(store, "mutate");
  const screen = await render(<Fit store={store} />);

  // Long enough for the face to settle and the effect to run.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(mutate).not.toHaveBeenCalled();
  expect(textsOf(store)[0]?.height).toBe(0.1);
  await screen.unmount();
});
