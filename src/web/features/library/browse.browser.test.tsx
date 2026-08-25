import { expect, it } from "vitest";
import type { LibraryItem, LibrarySort } from "@shared/schema/index.js";
import { browseLibrary, matchesQuery } from "./browse.js";

/*
 * Filtering and ordering, apart from the screen that shows them. app.js:1309-1312
 * filtered in the browser over the whole cached library, and this keeps that
 * while adding the sort the server has always offered but the page never did.
 */

let counter = 0;

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  counter += 1;
  return {
    id: `i${String(counter)}`,
    kind: "background",
    name: "Sunset",
    description: "",
    usage: "",
    tags: [],
    mediaId: "m1",
    ext: "png",
    url: "/media/m1.png",
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
    ...overrides,
  };
}

function used(timesUsed: number, lastUsedAt: number | null): LibraryItem["stats"] {
  return {
    timesUsed,
    slideshowCount: timesUsed === 0 ? 0 : 1,
    firstUsedAt: 1,
    lastUsedAt,
  };
}

function names(items: readonly LibraryItem[]): string[] {
  return items.map((entry) => entry.name);
}

/** A deterministic shuffle, so a sort test cannot pass on the input's own order. */
function shuffled<T>(input: readonly T[], seed: number): T[] {
  const out = [...input];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    const held = out[index] as T;
    out[index] = out[swap] as T;
    out[swap] = held;
  }
  return out;
}

it("keeps only the kind the page is showing", () => {
  const items = [
    item({ name: "Beach", kind: "background" }),
    item({ name: "Logo", kind: "asset" }),
  ];
  expect(
    names(browseLibrary(items, { kind: "asset", query: "", sort: "recent" })),
  ).toEqual(["Logo"]);
});

it("searches the name, the description, the usage note and the tags", () => {
  // Each of the four fields is the only place the word appears, so dropping any
  // one of them from the haystack fails here.
  const items = [
    item({ name: "Warm sunset" }),
    item({ name: "A", description: "A warm kitchen" }),
    item({ name: "B", usage: "Open a warm travel post with it" }),
    item({ name: "C", tags: ["warm", "travel"] }),
    item({ name: "D", description: "A cold morning" }),
  ];
  const found = browseLibrary(items, {
    kind: "background",
    query: "warm",
    sort: "recent",
  });
  expect(new Set(names(found))).toEqual(new Set(["Warm sunset", "A", "B", "C"]));
});

it("ignores case and the spaces around what was typed", () => {
  const items = [item({ name: "Sunset" }), item({ name: "Kitchen" })];
  for (const query of ["SUNSET", "  sunset ", "sUnSeT"]) {
    expect(
      names(browseLibrary(items, { kind: "background", query, sort: "recent" })),
    ).toEqual(["Sunset"]);
  }
});

it("keeps everything when nothing has been typed", () => {
  const items = [item({ name: "Sunset" }), item({ name: "Kitchen" })];
  for (const query of ["", "   "]) {
    expect(
      browseLibrary(items, { kind: "background", query, sort: "recent" }),
    ).toHaveLength(2);
  }
});

it("matches a fragment of a word, the way an includes does", () => {
  expect(matchesQuery(item({ name: "Sunset over water" }), "set ov")).toBe(true);
  expect(matchesQuery(item({ name: "Sunset over water" }), "setover")).toBe(false);
});

it("puts the least used first, which is what a varying agent asks for", () => {
  // Mirrors ORDER_BY["least-used"] in src/server/services/library.ts:25.
  const items = [
    item({ name: "Twice", stats: used(2, 500) }),
    item({ name: "Never", stats: used(0, null) }),
    item({ name: "Once late", stats: used(1, 900) }),
    item({ name: "Once early", stats: used(1, 100) }),
  ];
  const ordered = browseLibrary(shuffled(items, 7), {
    kind: "background",
    query: "",
    sort: "least-used",
  });
  expect(names(ordered)).toEqual(["Never", "Once early", "Once late", "Twice"]);
});

it("puts the most used first", () => {
  const items = [
    item({ name: "Twice", stats: used(2, 500) }),
    item({ name: "Never", stats: used(0, null) }),
    item({ name: "Five", stats: used(5, 100) }),
  ];
  const ordered = browseLibrary(shuffled(items, 3), {
    kind: "background",
    query: "",
    sort: "most-used",
  });
  expect(names(ordered)).toEqual(["Five", "Twice", "Never"]);
});

it("puts the most recently touched first by default", () => {
  const items = [
    item({ name: "Old", updatedAt: 10 }),
    item({ name: "New", updatedAt: 900 }),
    item({ name: "Middle", updatedAt: 100 }),
  ];
  const ordered = browseLibrary(shuffled(items, 11), {
    kind: "background",
    query: "",
    sort: "recent",
  });
  expect(names(ordered)).toEqual(["New", "Middle", "Old"]);
});

it("orders every sort monotonically whatever order the items arrive in", () => {
  const pool = Array.from({ length: 40 }, (_, index) =>
    item({
      name: `Item ${String(index)}`,
      updatedAt: (index * 37) % 41,
      stats: used((index * 13) % 7, index % 3 === 0 ? null : (index * 29) % 53),
    }),
  );

  const monotonic: Record<LibrarySort, (item: LibraryItem) => number> = {
    recent: (entry) => -entry.updatedAt,
    "least-used": (entry) => entry.stats.timesUsed,
    "most-used": (entry) => -entry.stats.timesUsed,
  };

  for (const sort of ["recent", "least-used", "most-used"] as const) {
    for (let seed = 1; seed <= 25; seed += 1) {
      const ordered = browseLibrary(shuffled(pool, seed), {
        kind: "background",
        query: "",
        sort,
      });
      expect(ordered).toHaveLength(pool.length);
      const keys = ordered.map(monotonic[sort]);
      for (let index = 1; index < keys.length; index += 1) {
        expect(keys[index] as number).toBeGreaterThanOrEqual(keys[index - 1] as number);
      }
    }
  }
});

it("returns the same order for the same input, whatever order it arrived in", () => {
  // A sort that leaves ties to arrival order makes the grid jump when an
  // unrelated item is saved, so every key is broken all the way down.
  const pool = Array.from({ length: 30 }, (_, index) =>
    item({
      name: `Item ${String(index)}`,
      updatedAt: index % 4,
      stats: used(index % 3, index % 2 === 0 ? null : index % 5),
    }),
  );
  for (const sort of ["recent", "least-used", "most-used"] as const) {
    const first = names(
      browseLibrary(shuffled(pool, 2), { kind: "background", query: "", sort }),
    );
    for (let seed = 3; seed <= 12; seed += 1) {
      expect(
        names(
          browseLibrary(shuffled(pool, seed), { kind: "background", query: "", sort }),
        ),
      ).toEqual(first);
    }
  }
});

it("orders by the frozen value where the caller supplies one", () => {
  // The item's own updatedAt says it is newest. The frozen map says it entered
  // the list third, and the list is what the reader is looking at.
  const items = [
    item({ name: "First", updatedAt: 300 }),
    item({ name: "Second", updatedAt: 200 }),
    item({ name: "Just saved", updatedAt: 9000 }),
  ];
  const frozen = new Map([[(items[2] as LibraryItem).id, 100]]);
  const ordered = browseLibrary(items, {
    kind: "background",
    query: "",
    sort: "recent",
    orderedAt: frozen,
  });
  expect(names(ordered)).toEqual(["First", "Second", "Just saved"]);
});

it("orders an item the frozen map has never seen by its own value", () => {
  // An upload arrives mid session and belongs at the top straight away.
  const items = [
    item({ name: "Held", updatedAt: 300 }),
    item({ name: "Fresh upload", updatedAt: 9000 }),
  ];
  const frozen = new Map([[(items[0] as LibraryItem).id, 300]]);
  const ordered = browseLibrary(items, {
    kind: "background",
    query: "",
    sort: "recent",
    orderedAt: frozen,
  });
  expect(names(ordered)).toEqual(["Fresh upload", "Held"]);
});

it("uses the frozen value for the tiebreak in the usage sorts too", () => {
  const items = [
    item({ name: "Older", updatedAt: 100, stats: used(2, 500) }),
    item({ name: "Just saved", updatedAt: 9000, stats: used(2, 500) }),
  ];
  const frozen = new Map([[(items[1] as LibraryItem).id, 50]]);
  for (const sort of ["least-used", "most-used"] as const) {
    const ordered = browseLibrary(items, {
      kind: "background",
      query: "",
      sort,
      orderedAt: frozen,
    });
    expect(names(ordered)).toEqual(["Older", "Just saved"]);
  }
});

it("leaves the caller's array alone", () => {
  const items = [
    item({ name: "Old", updatedAt: 1 }),
    item({ name: "New", updatedAt: 9 }),
  ];
  browseLibrary(items, { kind: "background", query: "", sort: "recent" });
  expect(names(items)).toEqual(["Old", "New"]);
});
