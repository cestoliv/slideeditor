import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { LibraryItem } from "@shared/schema/index.js";
import { LibraryCache, useLibrary } from "./useLibrary.js";
import type { LibraryClient } from "./useLibrary.js";

function item(id: string, name: string): LibraryItem {
  return {
    id,
    kind: "background",
    name,
    description: "",
    usage: "",
    tags: [],
    mediaId: `media-${id}`,
    ext: "jpg",
    url: `/media/media-${id}.jpg`,
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 2,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

function clientOf(...items: LibraryItem[]): LibraryClient & { calls: number } {
  const client = {
    calls: 0,
    listLibrary: () => {
      client.calls += 1;
      return Promise.resolve({ items, total: items.length });
    },
  };
  return client;
}

function Names({ cache }: { cache: LibraryCache }) {
  const { items, loading } = useLibrary(cache);
  return (
    <ul aria-label="library" data-loading={String(loading)}>
      {[...items.values()].map((entry) => (
        <li key={entry.id}>{entry.name}</li>
      ))}
    </ul>
  );
}

it("loads the library once, however many screens read it", async () => {
  const client = clientOf(item("i1", "Sunset"));
  const cache = new LibraryCache(client);
  const screen = await render(
    <>
      <Names cache={cache} />
      <Names cache={cache} />
    </>,
  );
  await expect.element(screen.getByText("Sunset").first()).toBeVisible();
  expect(client.calls).toBe(1);
});

it("asks for the whole library in one page", async () => {
  const listLibrary = vi.fn(() => Promise.resolve({ items: [], total: 0 }));
  await new LibraryCache({ listLibrary }).load();
  expect(listLibrary).toHaveBeenCalledWith({ limit: 200 });
});

it("resolves an id to its item without awaiting", async () => {
  const cache = new LibraryCache(clientOf(item("i1", "Sunset")));
  expect(cache.get("i1")).toBeNull();
  await cache.load();
  expect(cache.get("i1")?.name).toBe("Sunset");
  expect(cache.get("missing")).toBeNull();
  expect(cache.get(null)).toBeNull();
});

it("re-renders a reader when an item is folded in", async () => {
  const cache = new LibraryCache(clientOf());
  const screen = await render(<Names cache={cache} />);
  cache.remember(item("i2", "Neon"));
  await expect.element(screen.getByText("Neon")).toBeVisible();
});

it("drops a forgotten item from every reader", async () => {
  const cache = new LibraryCache(clientOf(item("i1", "Sunset")));
  const screen = await render(<Names cache={cache} />);
  await expect.element(screen.getByText("Sunset")).toBeVisible();
  cache.forget("i1");
  await expect.element(screen.getByText("Sunset")).not.toBeInTheDocument();
});

it("keeps the last good copy when a refresh fails", async () => {
  let fail = false;
  const cache = new LibraryCache({
    listLibrary: () =>
      fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ items: [item("i1", "Sunset")], total: 1 }),
  });
  await cache.load();
  fail = true;
  await cache.refresh();
  expect(cache.get("i1")?.name).toBe("Sunset");
  expect(cache.getSnapshot().error).toBeInstanceOf(Error);
  expect(cache.getSnapshot().loading).toBe(false);
});

it("shares one request between callers that arrive together", async () => {
  const client = clientOf(item("i1", "Sunset"));
  const cache = new LibraryCache(client);
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  expect(client.calls).toBe(1);
});
