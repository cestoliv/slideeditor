import { describe, expect, it } from "vitest";
import { BUILTIN_DEFAULTS } from "@shared/schema/index.js";
import { EditorStore } from "../store.js";
import { fixtureProject } from "../testing.js";
import { addTextLayer } from "./actions.js";

function storeAt() {
  const project = fixtureProject();
  return new EditorStore(project, { save: () => Promise.resolve(project) });
}

describe("addTextLayer", () => {
  it("adds a text layer at the default position when no point is given", () => {
    const store = storeAt();
    const id = addTextLayer(store, null, BUILTIN_DEFAULTS);
    expect(id).not.toBeNull();
    const slide = store.getSnapshot().project.slides[0];
    const layer = slide?.texts.find((text) => text.id === id);
    expect(layer).toMatchObject({ x: 0.18, y: 0.42, text: "Your text", style: "plain" });
  });

  it("centres the layer on a clicked point", () => {
    const store = storeAt();
    const id = addTextLayer(store, { x: 0.5, y: 0.5 }, BUILTIN_DEFAULTS);
    const slide = store.getSnapshot().project.slides[0];
    const layer = slide?.texts.find((text) => text.id === id);
    expect(layer?.x).toBeCloseTo(0.5 - BUILTIN_DEFAULTS.text.maxWidth / 2, 10);
    expect(layer?.y).toBeCloseTo(0.5 - 0.08 / 2, 10);
  });

  /*
   * Finding 1 from the controller's own verification pass: the default x
   * (0.18) was a bare literal, safe only because every account's width used
   * to be a fixed 0.64 (0.18 + 0.64 = 0.82). A wide account (maxWidth 1)
   * would push the box to 0.18..1.18, off the right edge, unless this
   * branch clamps the same way the clicked-point branch already does.
   */
  it("clamps the default position for an account with a full-width text default", () => {
    const store = storeAt();
    const defaults = {
      ...BUILTIN_DEFAULTS,
      text: { ...BUILTIN_DEFAULTS.text, maxWidth: 1 },
    };
    const id = addTextLayer(store, null, defaults);
    const slide = store.getSnapshot().project.slides[0];
    const layer = slide?.texts.find((text) => text.id === id);
    expect(layer?.x).toBe(0);
  });

  it("selects the new layer", () => {
    const store = storeAt();
    const id = addTextLayer(store, null, BUILTIN_DEFAULTS);
    expect(store.getSnapshot().selection).toEqual([`text:${id}`]);
  });

  it("returns null when no slide is active", () => {
    const project = fixtureProject();
    const store = new EditorStore(
      { ...project, slides: [] },
      { save: () => Promise.resolve(project) },
    );
    expect(addTextLayer(store, null, BUILTIN_DEFAULTS)).toBeNull();
  });
});
