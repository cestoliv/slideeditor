import type { LibraryItem, Slide } from "@shared/schema/index.js";
import type { LibraryCache } from "../../app/useLibrary.js";
import type { EditorStore } from "./store.js";

/*
 * Adding slides from backgrounds. Ported from addSlidesFromFiles and
 * handleUpload (app.js:4128-4192 at c6b3970, before the rewrite deleted it).
 *
 * Two differences from the original, both deliberate.
 *
 * app.js recorded its undo entry before the first upload and pushed each slide
 * as its upload landed, so a batch that failed halfway left an undo entry over
 * a document it had already half-changed. One mutate writes the whole batch
 * here, so it is one entry over one change, or nothing at all.
 *
 * And a slide starts from a library item rather than from a file. The picker
 * turns files into items, so choosing a curated background and uploading a new
 * one arrive here as the same thing, and this holds no upload logic at all.
 */

/** What became of a batch. The caller owns the wording, as RatioMenu's does. */
export type AddSlidesResult =
  { kind: "empty" } | { kind: "added"; count: number; firstId: string };

export type AddSlidesOptions = {
  /** The backgrounds, in the order they were chosen. One slide each. */
  items: readonly LibraryItem[];
  store: EditorStore;
  /** A new slide's background has to be in here, or nothing can draw it. */
  library: LibraryCache;
  newId?: (() => string) | undefined;
};

function slideFrom(item: LibraryItem, id: string): Slide {
  return {
    id,
    /*
     * The background's own name. app.js:4155 used the file's, and for an upload
     * this is that same name: the server stores nameForFile, which is the file
     * without its extension. A curated background brings the name its curator
     * gave it, which is the better one of the two.
     */
    name: item.name === "" ? "Slide" : item.name,
    backgroundItemId: item.id,
    width: item.width,
    height: item.height,
    imageScale: 1,
    imageX: 0,
    imageY: 0,
    texts: [],
    overlays: [],
  };
}

export function addSlidesFromItems(options: AddSlidesOptions): AddSlidesResult {
  const { items, store, library, newId = () => globalThis.crypto.randomUUID() } = options;

  if (items.length === 0) return { kind: "empty" };

  const added = items.map((item) => {
    // Into the cache before the document names it. Every render resolves a
    // background through here without awaiting, so a slide pointing at an item
    // the cache has not seen paints nothing at all. A background chosen from
    // the library is already in there, and re-publishing it would re-render
    // every screen holding the library for no change at all.
    if (library.get(item.id) === null) library.remember(item);
    return slideFrom(item, newId());
  });

  store.mutate((document) => {
    document.slides.push(...added);
  });
  const first = added[0];
  if (first === undefined) return { kind: "empty" };
  // app.js:4178 only jumped when nothing was active, which leaves someone who
  // pressed New slide looking at the slide they already had. The new one is
  // what they asked for, so it is what they get.
  store.setActiveSlide(first.id);
  return { kind: "added", count: added.length, firstId: first.id };
}
