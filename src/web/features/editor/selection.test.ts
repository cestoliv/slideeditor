import { describe, expect, it } from "vitest";
import type { Slide } from "@shared/schema/index.js";
import {
  isLayerSelected,
  layerKey,
  moveLayer,
  nextLayerZ,
  parseLayerKey,
  selectOnlyLayer,
  selectedLayers,
  setLayerSelection,
  slideItems,
  toggleLayerSelection,
} from "./selection.js";
import type { LayerKey, LayerMove } from "./selection.js";
import { fixtureProject } from "./testing.js";

const MOVES: LayerMove[] = ["front", "up", "down", "back"];

function slideWith(overlays: number, texts: number): Slide {
  const slide = fixtureProject({ overlays, texts }).slides[0];
  if (!slide) throw new Error("the fixture must build a slide");
  return slide;
}

/** The keys of a slide's layers, back to front. */
function order(slide: Slide): LayerKey[] {
  return slideItems(slide).map((entry) => entry.key);
}

describe("layer keys", () => {
  it("round trips a kind and an id", () => {
    expect(parseLayerKey(layerKey("overlay", "abc"))).toEqual({
      kind: "overlay",
      id: "abc",
    });
    expect(parseLayerKey(layerKey("text", "abc"))).toEqual({ kind: "text", id: "abc" });
  });

  it("splits on the first colon, so an id may contain one", () => {
    expect(parseLayerKey("text:a:b")).toEqual({ kind: "text", id: "a:b" });
  });

  it("answers null for a key it cannot read, rather than a kind that matches nothing", () => {
    expect(parseLayerKey("nonsense")).toBeNull();
    expect(parseLayerKey("sticker:1")).toBeNull();
  });
});

describe("slideItems", () => {
  it("interleaves overlays and texts into the one z-order they share", () => {
    const slide = slideWith(2, 2);
    slide.overlays[0]!.z = 3;
    slide.texts[0]!.z = 1;
    expect(order(slide)).toEqual([
      "text:text-1-1",
      "overlay:overlay-1-2",
      "overlay:overlay-1-1",
      "text:text-1-2",
    ]);
  });

  it("reads a missing z as zero, so an unordered layer sits at the back", () => {
    const slide = slideWith(1, 1);
    delete slide.overlays[0]!.z;
    expect(order(slide)[0]).toBe("overlay:overlay-1-1");
  });

  /**
   * The tie-break, which nothing else pins. slideItems concatenates overlays
   * before texts and then sorts, and Array.prototype.sort is stable, so two
   * layers sharing a z keep that order: the overlay sits behind the text.
   * assignLayerOrder numbers overlays first for the same reason
   * (src/shared/schema/document.ts:137-146), so the two agree.
   */
  it("puts an overlay behind a text when the two share a z", () => {
    const slide = slideWith(1, 1);
    slide.overlays[0]!.z = 2;
    slide.texts[0]!.z = 2;
    expect(order(slide)).toEqual(["overlay:overlay-1-1", "text:text-1-1"]);
  });

  it("keeps overlays behind texts when every layer shares a z", () => {
    const slide = slideWith(2, 2);
    slide.overlays.forEach((overlay) => {
      overlay.z = 1;
    });
    slide.texts.forEach((text) => {
      text.z = 1;
    });
    expect(order(slide)).toEqual([
      "overlay:overlay-1-1",
      "overlay:overlay-1-2",
      "text:text-1-1",
      "text:text-1-2",
    ]);
  });

  /**
   * A move reads its start index out of the tie-broken order, so the two have
   * to agree. Three layers is the smallest slide where they can disagree: with
   * only a tied pair, every move collapses to the same answer either way.
   */
  it("steps a tied text down past the overlay it was tied with", () => {
    const slide = slideWith(2, 1);
    slide.overlays[0]!.z = 1;
    slide.overlays[1]!.z = 2;
    slide.texts[0]!.z = 2;
    expect(order(slide)).toEqual([
      "overlay:overlay-1-1",
      "overlay:overlay-1-2",
      "text:text-1-1",
    ]);
    moveLayer(slide, "text", "text-1-1", "down");
    expect(order(slide)).toEqual([
      "overlay:overlay-1-1",
      "text:text-1-1",
      "overlay:overlay-1-2",
    ]);
    expect(slideItems(slide).map((entry) => entry.item.z)).toEqual([1, 2, 3]);
  });

  it("hands back nothing for a slide that is not there", () => {
    expect(slideItems(null)).toEqual([]);
  });
});

describe("nextLayerZ", () => {
  it("starts at one on an empty slide", () => {
    expect(nextLayerZ(slideWith(0, 0))).toBe(1);
  });

  it("clears the highest layer on the slide", () => {
    const slide = slideWith(1, 1);
    slide.texts[0]!.z = 7;
    expect(nextLayerZ(slide)).toBe(8);
  });
});

describe("setLayerSelection", () => {
  it("drops a key whose layer is not on the slide", () => {
    const slide = slideWith(1, 1);
    const selection = setLayerSelection(slide, [
      "text:text-1-1",
      "overlay:gone",
    ] as LayerKey[]);
    expect(selection.keys).toEqual(["text:text-1-1"]);
  });

  it("drops duplicates but keeps the first position of each key", () => {
    const slide = slideWith(1, 1);
    const selection = setLayerSelection(slide, [
      "text:text-1-1",
      "overlay:overlay-1-1",
      "text:text-1-1",
    ] as LayerKey[]);
    expect(selection.keys).toEqual(["text:text-1-1", "overlay:overlay-1-1"]);
  });

  it("falls back to the last surviving key when the primary was dropped", () => {
    const slide = slideWith(1, 1);
    const selection = setLayerSelection(
      slide,
      ["text:text-1-1", "overlay:overlay-1-1"] as LayerKey[],
      "overlay:gone" as LayerKey,
    );
    expect(selection.primary).toBe("overlay:overlay-1-1");
  });

  it("keeps a primary that survived, even when it is not the last key", () => {
    const slide = slideWith(1, 1);
    const selection = setLayerSelection(
      slide,
      ["text:text-1-1", "overlay:overlay-1-1"] as LayerKey[],
      "text:text-1-1" as LayerKey,
    );
    expect(selection.primary).toBe("text:text-1-1");
  });

  it("has no primary when nothing survived", () => {
    const slide = slideWith(1, 1);
    expect(setLayerSelection(slide, ["overlay:gone"] as LayerKey[])).toEqual({
      keys: [],
      primary: null,
    });
  });

  it("drops everything when the slide is gone, rather than throwing", () => {
    expect(setLayerSelection(null, ["text:text-1-1"] as LayerKey[])).toEqual({
      keys: [],
      primary: null,
    });
  });
});

describe("selectOnlyLayer and toggleLayerSelection", () => {
  it("replaces the selection and makes the layer primary", () => {
    const slide = slideWith(1, 1);
    expect(selectOnlyLayer(slide, "overlay", "overlay-1-1")).toEqual({
      keys: ["overlay:overlay-1-1"],
      primary: "overlay:overlay-1-1",
    });
  });

  it("adds a layer and makes it primary", () => {
    const slide = slideWith(1, 1);
    expect(
      toggleLayerSelection(
        slide,
        ["text:text-1-1"] as LayerKey[],
        "overlay",
        "overlay-1-1",
      ),
    ).toEqual({
      keys: ["text:text-1-1", "overlay:overlay-1-1"],
      primary: "overlay:overlay-1-1",
    });
  });

  it("removes a layer already selected and promotes what is left", () => {
    const slide = slideWith(1, 1);
    expect(
      toggleLayerSelection(
        slide,
        ["text:text-1-1", "overlay:overlay-1-1"] as LayerKey[],
        "overlay",
        "overlay-1-1",
      ),
    ).toEqual({ keys: ["text:text-1-1"], primary: "text:text-1-1" });
  });

  it("reports membership by kind and id", () => {
    const keys = ["text:text-1-1"] as LayerKey[];
    expect(isLayerSelected(keys, "text", "text-1-1")).toBe(true);
    expect(isLayerSelected(keys, "overlay", "text-1-1")).toBe(false);
  });

  it("resolves selected layers in selection order, not z-order", () => {
    const slide = slideWith(1, 1);
    const resolved = selectedLayers(slide, [
      "text:text-1-1",
      "overlay:overlay-1-1",
    ] as LayerKey[]);
    expect(resolved.map((entry) => entry.key)).toEqual([
      "text:text-1-1",
      "overlay:overlay-1-1",
    ]);
  });
});

describe("moveLayer, one layer", () => {
  it("moves a text above an overlay that shares the slide", () => {
    const slide = slideWith(1, 1);
    expect(order(slide)).toEqual(["overlay:overlay-1-1", "text:text-1-1"]);
    moveLayer(slide, "overlay", "overlay-1-1", "front");
    expect(order(slide)).toEqual(["text:text-1-1", "overlay:overlay-1-1"]);
    moveLayer(slide, "text", "text-1-1", "front");
    expect(order(slide)).toEqual(["overlay:overlay-1-1", "text:text-1-1"]);
  });

  it("does nothing when the front-most layer is sent forward", () => {
    const slide = slideWith(2, 2);
    const before = order(slide);
    moveLayer(slide, "text", "text-1-2", "up");
    expect(order(slide)).toEqual(before);
  });

  it("does nothing when the back-most layer is sent backward", () => {
    const slide = slideWith(2, 2);
    const before = order(slide);
    moveLayer(slide, "overlay", "overlay-1-1", "down");
    expect(order(slide)).toEqual(before);
  });

  it("leaves the slide alone and reports false for a layer that is not there", () => {
    const slide = slideWith(1, 1);
    const before = order(slide);
    expect(moveLayer(slide, "overlay", "gone", "front")).toBe(false);
    expect(order(slide)).toEqual(before);
  });

  it("reports false rather than throwing when there is no slide", () => {
    expect(moveLayer(null, "text", "text-1-1", "front")).toBe(false);
  });

  // The whole point of the dense rewrite: a slide whose z values start sparse
  // still moves one step at a time afterwards.
  it("closes gaps in a sparse z-order", () => {
    const slide = slideWith(2, 1);
    slide.overlays[0]!.z = 4;
    slide.overlays[1]!.z = 90;
    slide.texts[0]!.z = 900;
    moveLayer(slide, "text", "text-1-1", "down");
    expect(slideItems(slide).map((entry) => entry.item.z)).toEqual([1, 2, 3]);
    expect(order(slide)).toEqual([
      "overlay:overlay-1-1",
      "text:text-1-1",
      "overlay:overlay-1-2",
    ]);
  });
});

// Exhaustive over every slide size, every target, and every move, so a change
// to the algorithm that happens to satisfy the examples above still has to
// satisfy the meaning of each move.
describe("moveLayer holds its meaning for every layer and every move", () => {
  for (let size = 2; size <= 6; size += 1) {
    for (const move of MOVES) {
      it(`keeps ${size} layers dense and well placed on "${move}"`, () => {
        const overlays = Math.ceil(size / 2);
        for (let target = 0; target < size; target += 1) {
          const slide = slideWith(overlays, size - overlays);
          const before = order(slide);
          const key = before[target];
          if (!key) throw new Error("the fixture must build every layer");
          const parsed = parseLayerKey(key);
          if (!parsed) throw new Error("the fixture must build readable keys");

          expect(moveLayer(slide, parsed.kind, parsed.id, move)).toBe(true);
          const after = order(slide);

          // Nothing is created, lost, or duplicated.
          expect([...after].sort()).toEqual([...before].sort());
          // z is exactly 1..n, with no gaps and no ties.
          expect(slideItems(slide).map((entry) => entry.item.z)).toEqual(
            Array.from({ length: size }, (_value, index) => index + 1),
          );

          const expectedIndex =
            move === "front"
              ? size - 1
              : move === "back"
                ? 0
                : move === "up"
                  ? Math.min(target + 1, size - 1)
                  : Math.max(target - 1, 0);
          expect(after.indexOf(key)).toBe(expectedIndex);

          // Every other layer keeps its relative order.
          expect(after.filter((entry) => entry !== key)).toEqual(
            before.filter((entry) => entry !== key),
          );
        }
      });
    }
  }
});

describe("moveLayer, a multi-layer selection", () => {
  // Five layers, back to front: overlay 1, overlay 2, overlay 3, text 1, text 2.
  const five = () => slideWith(3, 2);
  const A = "overlay:overlay-1-1" as LayerKey;
  const B = "overlay:overlay-1-2" as LayerKey;
  const C = "overlay:overlay-1-3" as LayerKey;
  const D = "text:text-1-1" as LayerKey;
  const E = "text:text-1-2" as LayerKey;

  it("partitions the list on front, keeping the selected group in its own order", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "front", [B, D]);
    expect(order(slide)).toEqual([A, C, E, B, D]);
  });

  it("partitions the list on back, keeping the selected group in its own order", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "back", [B, D]);
    expect(order(slide)).toEqual([B, D, A, C, E]);
  });

  // A single backwards pass. Walking forwards instead would carry the upper
  // member of the pair two places and past a layer it should never cross.
  it("lifts a contiguous group one step on up, without reordering it", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "up", [B, C]);
    expect(order(slide)).toEqual([A, D, B, C, E]);
  });

  it("lowers a contiguous group one step on down, without reordering it", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "down", [B, C]);
    expect(order(slide)).toEqual([B, C, A, D, E]);
  });

  it("lifts a split group one step on up", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "up", [B, D]);
    expect(order(slide)).toEqual([A, C, B, E, D]);
  });

  it("stops a group at the top rather than letting the lower member catch up", () => {
    const slide = five();
    moveLayer(slide, "text", "text-1-1", "up", [D, E]);
    expect(order(slide)).toEqual([A, B, C, D, E]);
  });

  it("keeps the merged order dense after a group move", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-2", "front", [B, D]);
    expect(slideItems(slide).map((entry) => entry.item.z)).toEqual([1, 2, 3, 4, 5]);
  });

  it("moves only the clicked layer when it is outside the current selection", () => {
    const slide = five();
    moveLayer(slide, "overlay", "overlay-1-1", "front", [B, D]);
    expect(order(slide)).toEqual([B, C, D, E, A]);
  });
});
