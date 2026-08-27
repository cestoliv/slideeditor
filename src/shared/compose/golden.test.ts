import { expect, it } from "vitest";
import type { LibraryItem, SlideDocument } from "../schema/index.js";
import { BUILTIN_DEFAULTS } from "../schema/index.js";
import { composeDocument } from "./compose.js";
import type { Composition, ComposeDocumentInput, LibraryLookup } from "./compose.js";
// Imported as a module rather than read off disk, because everything under
// src/shared has to type check for the browser too, and node:fs does not exist
// there. Vitest resolves the JSON itself, so the path is relative to this file
// and not to the process cwd.
import golden from "../../../tests/fixtures/golden-compose.json" with { type: "json" };

// The item table from the capture script, verbatim. compose reads only these
// four fields, so a stub carrying exactly them produces the same geometry the
// real library service does.
type StubItem = Pick<LibraryItem, "id" | "kind" | "width" | "height">;

const items: Record<string, StubItem> = {
  bg1: { id: "bg1", kind: "background", width: 1080, height: 1920 },
  bg2: { id: "bg2", kind: "background", width: 1200, height: 1200 },
  a1: { id: "a1", kind: "asset", width: 400, height: 200 },
  a2: { id: "a2", kind: "asset", width: 200, height: 400 },
  a3: { id: "a3", kind: "asset", width: 300, height: 300 },
  a4: { id: "a4", kind: "asset", width: 500, height: 100 },
};

const library: LibraryLookup = {
  require: (id) => {
    const item = items[id];
    if (!item) throw new Error(`No library item with id ${id}`);
    return item as LibraryItem;
  },
};

// The case list from the capture script, verbatim.
const cases: { ratio: { w: number; h: number }; slides: Composition[] }[] = [
  { ratio: { w: 9, h: 16 }, slides: [{ background: "bg1", assets: [], texts: [] }] },
  {
    ratio: { w: 9, h: 16 },
    slides: [{ background: "bg1", assets: ["a1"], texts: ["Short line"] }],
  },
  {
    ratio: { w: 4, h: 5 },
    slides: [
      {
        background: "bg2",
        assets: ["a1", "a2", "a3", "a4"],
        texts: ["One", "Two", "Three"],
      },
    ],
  },
  {
    ratio: { w: 1, h: 1 },
    slides: [
      {
        background: "bg2",
        assets: [],
        texts: [
          "A very long line that has to wrap several times before it fits inside the content width of the slide",
        ],
      },
    ],
  },
  {
    ratio: { w: 1.91, h: 1 },
    slides: [
      {
        background: "bg1",
        assets: ["a1", "a2"],
        texts: ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"],
      },
    ],
  },
];

// The strip helper from the capture script, verbatim. Ids are random, so they
// are dropped before comparing.
const strip = (doc: SlideDocument) => ({
  ratio: doc.ratio,
  slides: doc.slides.map((s) => ({
    ...s,
    id: undefined,
    overlays: s.overlays.map((o) => ({ ...o, id: undefined })),
    texts: s.texts.map((t) => ({ ...t, id: undefined })),
  })),
});

// Not "the previous engine's geometry" any more: the size ladder is gone
// (product decision), and an unfittable text block (case 4 below) is
// centered on the frame rather than floored to one edge, so this fixture is
// regenerated against the current engine rather than transcribed from
// server/compose.mjs. What this still guards is regression-by-omission — a
// change to compose.ts or constants.ts that shifts placement without anyone
// meaning it to.
it("matches this engine's recorded geometry exactly", () => {
  const input = (entry: (typeof cases)[number]): ComposeDocumentInput => ({
    ...entry,
    library,
    defaults: BUILTIN_DEFAULTS,
  });
  expect(cases.map((entry) => strip(composeDocument(input(entry))))).toEqual(golden);
});
