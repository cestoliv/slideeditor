import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
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
    accountId: DEFAULT_ACCOUNT_ID,
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

/*
 * A client method that throws SYNCHRONOUSLY (a missing method, a transport
 * that blows up before ever returning a promise) used to throw straight out
 * of refresh() itself — refresh() is not `async`, so calling
 * this.client.listLibrary(query) directly, before `.then`/`.catch` were
 * attached, propagated the throw to whoever called load()/refresh() (an
 * effect, in the common case) instead of landing in `error` the way a
 * rejected listLibrary() already does.
 */
it("records a synchronous throw from the client in error, rather than letting refresh() throw", async () => {
  const cache = new LibraryCache({
    listLibrary: () => {
      throw new Error("listLibrary is not a function");
    },
  });

  await expect(cache.refresh()).resolves.toEqual(new Map());

  expect(cache.getSnapshot().error).toBeInstanceOf(Error);
  expect(cache.getSnapshot().loading).toBe(false);
});

it("shares one request between callers that arrive together", async () => {
  const client = clientOf(item("i1", "Sunset"));
  const cache = new LibraryCache(client);
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  expect(client.calls).toBe(1);
});

it("passes the open slideshow's account through to the fetch", async () => {
  const listLibrary = vi.fn(() => Promise.resolve({ items: [], total: 0 }));
  await new LibraryCache({ listLibrary }).load("account-b");
  expect(listLibrary).toHaveBeenCalledWith({ limit: 200, account: "account-b" });
});

it("finds an account's own items even when they fall outside the unscoped page", async () => {
  // The regression this guards: the cache used to fetch one unscoped
  // 200-item page (server-ordered by updated_at DESC) no matter whose
  // slideshow was open. An account with older items than every other
  // account's newest 200 was then invisible everywhere the cache is read
  // from - the background picker, the asset rail, and a slide's own
  // background on the stage - even though the server holds its items fine.
  const accountAItems = Array.from({ length: 200 }, (_, i) => ({
    ...item(`a${String(i)}`, `A ${String(i)}`),
    accountId: "account-a",
  }));
  const accountBItem = { ...item("b0", "Older B item"), accountId: "account-b" };
  const client: LibraryClient = {
    listLibrary: ({ account } = {}) => {
      if (account === "account-b") {
        return Promise.resolve({ items: [accountBItem], total: 1 });
      }
      if (account === "account-a") {
        return Promise.resolve({ items: accountAItems, total: accountAItems.length });
      }
      // The unscoped page: newest 200 across every account, which is all of
      // account A's and none of account B's older item.
      return Promise.resolve({ items: accountAItems, total: accountAItems.length + 1 });
    },
  };
  const cache = new LibraryCache(client);
  const items = await cache.load("account-b");
  expect(items.get("b0")?.name).toBe("Older B item");
  expect(items.has("a0")).toBe(false);
});

/*
 * Finding 12: remember()/forget() used to touch the single shared slot —
 * now that the unscoped page and an account's own scope can both be loaded
 * at once, a folded-in or removed item has to reach whichever of those is
 * actually loaded, not just whichever one happened to load last.
 */
it("folds a remembered item into every loaded scope that should hold it", async () => {
  const cache = new LibraryCache(clientOf());
  await cache.load(undefined);
  await cache.load("account-a");
  const added = { ...item("i2", "Neon"), accountId: "account-a" };
  cache.remember(added);
  expect(cache.getSnapshot(undefined).items.get("i2")?.name).toBe("Neon");
  expect(cache.getSnapshot("account-a").items.get("i2")?.name).toBe("Neon");
  // A different account's scope, also loaded, must not gain an item that is
  // not its own.
  await cache.load("account-b");
  cache.remember({ ...item("i3", "Dusk"), accountId: "account-a" });
  expect(cache.getSnapshot("account-b").items.has("i3")).toBe(false);
});

it("drops a forgotten item from every loaded scope, not just the last one loaded", async () => {
  const cache = new LibraryCache(clientOf(item("i1", "Sunset")));
  await cache.load(undefined);
  await cache.load(DEFAULT_ACCOUNT_ID);
  cache.forget("i1");
  expect(cache.getSnapshot(undefined).items.has("i1")).toBe(false);
  expect(cache.getSnapshot(DEFAULT_ACCOUNT_ID).items.has("i1")).toBe(false);
});

function ScopedNames({
  cache,
  accountId,
  ready,
}: {
  cache: LibraryCache;
  accountId?: string;
  ready?: boolean;
}) {
  const { items, loading } = useLibrary(cache, accountId, ready);
  return (
    <ul aria-label="library" data-loading={String(loading)}>
      {[...items.values()].map((entry) => (
        <li key={entry.id}>{entry.name}</li>
      ))}
    </ul>
  );
}

/*
 * Finding 4: the editor's own accountId is undefined on its very first
 * render (the project itself has not loaded yet), and useLibrary's effect
 * used to fire unconditionally on every accountId change — including that
 * first undefined one. That fired a full unscoped fetch purely to have it
 * discarded a render later once the real, scoped accountId arrived.
 * `ready: false` is what a caller in that state passes to skip firing
 * anything at all until its own scope is known.
 */
it("fires no load while ready is false, however accountId changes underneath it", async () => {
  const client = clientOf(item("i1", "Sunset"));
  const screen = await render(
    <ScopedNames cache={new LibraryCache(client)} ready={false} />,
  );
  // Give any effect a turn to run before asserting nothing fired.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(client.calls).toBe(0);
  expect(screen.getByText("Sunset").query()).toBeNull();
});

/*
 * Finding 4: BackgroundPicker used to call useLibrary(cache) with no
 * accountId on the very same cache instance Editor.tsx scopes to the open
 * slideshow's account — so `loadedAccountId` was decided by whichever
 * effect happened to fire last, not by which scope was actually wanted.
 * Both callers passing the SAME accountId (the real fix, in Editor.tsx and
 * BackgroundPicker.tsx) is what this guards: two readers of one cache,
 * agreeing on scope, must converge on that scope's data regardless of mount
 * order, rather than whichever one raced past the other.
 */
it("converges on one scope when two readers of the same cache agree on it, regardless of mount order", async () => {
  const accountAItem = { ...item("a0", "A item"), accountId: "account-a" };
  const accountBItem = { ...item("b0", "B item"), accountId: "account-b" };
  const client: LibraryClient = {
    listLibrary: ({ account } = {}) =>
      Promise.resolve(
        account === "account-b"
          ? { items: [accountBItem], total: 1 }
          : { items: [accountAItem], total: 1 },
      ),
  };
  const cache = new LibraryCache(client);
  const screen = await render(
    <>
      <ScopedNames cache={cache} accountId="account-b" />
      <ScopedNames cache={cache} accountId="account-b" />
    </>,
  );
  await expect.element(screen.getByText("B item").first()).toBeVisible();
  expect(screen.getByText("A item").query()).toBeNull();
});

/*
 * Finding 12: the cache used to be a single slot, keyed by whichever scope
 * loaded it most recently — so the editor (scoped to the open slideshow's
 * account) and every other screen (unscoped) evicted each other's data on
 * every crossing. Editor -> library -> editor used to cost three full
 * queries; each scope now keeps its own slot, so returning to a
 * previously-loaded scope costs nothing.
 */
it("keeps a previously-loaded scope's data rather than evicting it for a different one", async () => {
  const calls: (string | undefined)[] = [];
  const client: LibraryClient = {
    listLibrary: ({ account } = {}) => {
      calls.push(account);
      return Promise.resolve({ items: [], total: 0 });
    },
  };
  const cache = new LibraryCache(client);
  await cache.load("account-a"); // the editor, scoped
  await cache.load(undefined); // the library screen, unscoped
  await cache.load("account-a"); // back to the editor: no refetch
  await cache.load(undefined); // back to the library screen: no refetch
  expect(calls).toEqual(["account-a", undefined]);
});

it("refetches when the scope changes, and answers a stale scope's callers from its own request", async () => {
  const calls: (string | undefined)[] = [];
  const client: LibraryClient = {
    listLibrary: ({ account } = {}) => {
      calls.push(account);
      return Promise.resolve({ items: [], total: 0 });
    },
  };
  const cache = new LibraryCache(client);
  await cache.load(undefined);
  await cache.load("account-a");
  // Same scope as the last completed load: answered from cache, no refetch.
  await cache.load("account-a");
  await cache.load("account-b");
  expect(calls).toEqual([undefined, "account-a", "account-b"]);
});

/*
 * Finding 12's own regression: the e2e harness's openApp() reuses this
 * module's one singleton across every test in a file, and used to force a
 * fresh read by calling the unscoped refresh() alone — which was enough
 * when the whole cache was one slot that any refresh() evicted, but once a
 * scope is its own independent slot (this fix), an EARLIER test's already-
 * loaded account stayed cached right through a LATER test's unscoped
 * refresh, serving a stale page for an account a fresh seed had just added
 * items to. invalidate() is what openApp() now calls first — this is the
 * property it depends on: a scope already loaded still answers load() from
 * cache until invalidate() runs, and refetches on the very next load() once
 * it has.
 */
it("invalidate() forces every scope, loaded or not, to refetch on its next load()", async () => {
  const calls: (string | undefined)[] = [];
  const client: LibraryClient = {
    listLibrary: ({ account } = {}) => {
      calls.push(account);
      return Promise.resolve({ items: [], total: 0 });
    },
  };
  const cache = new LibraryCache(client);
  await cache.load("account-a");
  await cache.load("account-a"); // cached, no refetch yet
  expect(calls).toEqual(["account-a"]);

  cache.invalidate();
  await cache.load("account-a");
  expect(calls).toEqual(["account-a", "account-a"]);
});

it("invalidate() does not blank what is already cached before the refetch resolves", async () => {
  const cache = new LibraryCache(clientOf(item("i1", "Sunset")));
  await cache.load("account-a");
  cache.invalidate();
  expect(cache.get("i1")?.name).toBe("Sunset");
});
