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
    expect(layer?.x).toBeCloseTo(0.5 - 0.64 / 2, 10);
    expect(layer?.y).toBeCloseTo(0.5 - 0.08 / 2, 10);
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
