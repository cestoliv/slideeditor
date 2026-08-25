import type { LibraryItem, LibraryKind, LibrarySort } from "@shared/schema/index.js";

/*
 * What the grid shows, out of everything the cache holds.
 *
 * app.js:1309-1312 filtered in the browser over the whole library, because the
 * cache already had every item and a round trip per keystroke would have been
 * slower than the filter. That stays. The sort is new: the server has ordered
 * three ways since the agent backend landed (ORDER_BY in
 * src/server/services/library.ts:22-27) and the admin page never offered it.
 */

export type BrowseOptions = {
  kind: LibraryKind;
  query: string;
  sort: LibrarySort;
  /**
   * The `updatedAt` to order each item by, which is not always the item's own.
   *
   * Every sort here keys on `updatedAt`, and the server stamps it on every
   * PATCH (src/server/services/library.ts:236). Ordering by the live value
   * moves the card a person just typed into, and the card they meant to edit
   * next is no longer under their cursor. The screen therefore freezes the
   * value each item entered the list with and passes it here. An id the map
   * does not hold is new to the list and orders by its own.
   */
  orderedAt?: ReadonlyMap<string, number>;
};

/** app.js:1311. One haystack of every field a person might remember. */
function haystack(item: LibraryItem): string {
  return `${item.name} ${item.description} ${item.usage} ${item.tags.join(" ")}`.toLowerCase();
}

export function matchesQuery(item: LibraryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return haystack(item).includes(needle);
}

/*
 * Mirrors ORDER_BY in src/server/services/library.ts:22-27, with the item's id
 * added as the last key. The server's own orders are not total, and a grid whose
 * tied items swap places when an unrelated card is saved reads as a bug.
 */
type Ordering = (
  at: (item: LibraryItem) => number,
) => (a: LibraryItem, b: LibraryItem) => number;

const comparators: Record<LibrarySort, Ordering> = {
  recent: (at) => (a, b) => at(b) - at(a) || compareIds(a, b),
  // A never used item sorts first, which is exactly what a varying agent wants.
  "least-used": (at) => (a, b) =>
    a.stats.timesUsed - b.stats.timesUsed ||
    (a.stats.lastUsedAt ?? 0) - (b.stats.lastUsedAt ?? 0) ||
    at(b) - at(a) ||
    compareIds(a, b),
  "most-used": (at) => (a, b) =>
    b.stats.timesUsed - a.stats.timesUsed || at(b) - at(a) || compareIds(a, b),
};

function compareIds(a: LibraryItem, b: LibraryItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function browseLibrary(
  items: Iterable<LibraryItem>,
  options: BrowseOptions,
): LibraryItem[] {
  const kept: LibraryItem[] = [];
  for (const item of items) {
    if (item.kind !== options.kind) continue;
    if (!matchesQuery(item, options.query)) continue;
    kept.push(item);
  }
  const frozen = options.orderedAt;
  const at =
    frozen === undefined
      ? (item: LibraryItem) => item.updatedAt
      : (item: LibraryItem) => frozen.get(item.id) ?? item.updatedAt;
  return kept.sort(comparators[options.sort](at));
}
