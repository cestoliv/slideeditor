import { expect, it } from "vitest";
import type { LibraryItem } from "@shared/schema/index.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { addSlidesFromItems } from "./addSlides.js";
import { EditorStore } from "./store.js";
import { fixtureProject } from "./testing.js";

/*
 * The batch, without the browser. Choosing the backgrounds is the picker's, and
 * the wiring that reaches this is covered in Editor.browser.test.tsx; what is
 * here is what a batch does to the document.
 */

function item(id: string, name = id, width = 1080, height = 1920): LibraryItem {
  return {
    id,
    kind: "background",
    name,
    description: "",
    usage: "",
    tags: [],
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width,
    height,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

function harness() {
  const project = fixtureProject({ slides: 1 });
  const store = new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
  const cache = new LibraryCache({
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
  });
  let next = 0;
  const newId = () => {
    next += 1;
    return `new-${String(next)}`;
  };
  return { project, store, cache, newId };
}

it("turns every chosen background into a slide, in the order chosen", () => {
  const { store, cache, newId } = harness();
  const result = addSlidesFromItems({
    items: [item("item-beach", "beach", 800, 600), item("item-dunes", "dunes", 800, 600)],
    store,
    library: cache,
    newId,
  });

  expect(result).toEqual({ kind: "added", count: 2, firstId: "new-1" });
  const slides = store.getSnapshot().project.slides;
  expect(slides.map((slide) => slide.name)).toEqual(["Slide 1", "beach", "dunes"]);
  expect(slides[1]?.backgroundItemId).toBe("item-beach");
  // The background's own pixels, so the photo is not stretched to the old ones.
  expect(slides[1]?.width).toBe(800);
  expect(slides[1]?.height).toBe(600);
  expect(slides[1]?.texts).toEqual([]);
  expect(slides[1]?.overlays).toEqual([]);
});

it("puts a background the cache has not seen in it before the document names it", () => {
  const { store, cache, newId } = harness();
  addSlidesFromItems({ items: [item("item-beach")], store, library: cache, newId });
  // Every render resolves a background through the cache without awaiting, so
  // a slide naming an item the cache has not seen paints nothing at all.
  expect(cache.get("item-beach")?.url).toBe("/media/item-beach.png");
});

it("shows the first slide it added", () => {
  const { store, cache, newId } = harness();
  expect(store.getSnapshot().activeSlideId).toBe("slide-1");
  addSlidesFromItems({
    items: [item("item-beach"), item("item-dunes")],
    store,
    library: cache,
    newId,
  });
  expect(store.getSnapshot().activeSlideId).toBe("new-1");
});

it("takes one undo entry for the whole batch", () => {
  const { store, cache, newId } = harness();
  expect(store.canUndo()).toBe(false);
  addSlidesFromItems({
    items: [item("a"), item("b"), item("c")],
    store,
    library: cache,
    newId,
  });
  expect(store.getSnapshot().project.slides).toHaveLength(4);

  // Three slides in, one press out.
  store.undo();
  expect(store.getSnapshot().project.slides).toHaveLength(1);
  expect(store.canUndo()).toBe(false);
});

it("writes nothing at all when it is handed nothing", () => {
  const { store, cache, newId } = harness();
  const result = addSlidesFromItems({ items: [], store, library: cache, newId });

  expect(result).toEqual({ kind: "empty" });
  expect(store.getSnapshot().project.slides).toHaveLength(1);
  // No entry either, so an undo does not back out of a change never made.
  expect(store.canUndo()).toBe(false);
});

it("falls back to a name a slide rail can show", () => {
  const { store, cache, newId } = harness();
  // The server names every upload, but a library item edited to nothing would
  // otherwise leave a nameless row in the rail.
  addSlidesFromItems({ items: [item("item-1", "")], store, library: cache, newId });
  expect(store.getSnapshot().project.slides[1]?.name).toBe("Slide");
});
