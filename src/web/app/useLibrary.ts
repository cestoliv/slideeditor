import { useEffect, useSyncExternalStore } from "react";
import type { LibraryItem } from "@shared/schema/index.js";
import { api } from "./api.js";
import type { LibraryQuery } from "./api.js";

/*
 * The library, cached by id. Every render path resolves an item id to an image
 * URL without awaiting (app.js:288-296), so this is one store the whole app
 * reads rather than a fetch per component.
 */

/** app.js:293 asks for 200 in one go, which is the server's own ceiling. */
const LIBRARY_PAGE_SIZE = 200;

export type LibraryIndex = ReadonlyMap<string, LibraryItem>;

export type LibraryState = {
  items: LibraryIndex;
  loading: boolean;
  error: unknown;
};

export type LibraryClient = Pick<typeof api, "listLibrary">;

const EMPTY: LibraryIndex = new Map();

/**
 * The state for a scope nobody has ever loaded. One fixed reference, reused
 * every time `getSnapshot` is asked about an unloaded scope, so
 * useSyncExternalStore sees the same object back until that scope's own
 * first `refresh()` actually changes it (returning a fresh `{...}` on every
 * call would look like a perpetually-changing snapshot instead).
 */
const EMPTY_STATE: LibraryState = { items: EMPTY, loading: false, error: null };

export class LibraryCache {
  /**
   * One independent state per scope (`accountId`, or `undefined` for the
   * unscoped, cross-account page), keyed the same way `load`/`refresh`
   * already were — but no longer evicting one another. Before this, the
   * whole cache was a single slot: the editor scopes it to the open
   * slideshow's account while every other screen (the library admin
   * screens, in particular) reads it unscoped, so navigating between an
   * editor and one of those screens used to throw the other's page away and
   * refetch a fresh 200-item, stats-joined page on every crossing — three
   * full queries for editor → library → editor, one of them wasted on data
   * still sitting right there under a different key.
   */
  private scopes = new Map<string | undefined, LibraryState>();
  private readonly listeners = new Set<() => void>();
  private pending = new Map<string | undefined, Promise<LibraryIndex>>();
  /** Per-scope request counters, so a slow answer for a scope cannot overwrite that same scope's newer one — but no longer needs to guard against a DIFFERENT scope's request at all, since each now owns its own slot. */
  private installedRequest = new Map<string | undefined, number>();
  private latestRequest = 0;

  readonly client: LibraryClient;

  constructor(client: LibraryClient = api) {
    this.client = client;
  }

  /* Bound as fields, because useSyncExternalStore resubscribes on a new identity. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (accountId?: string): LibraryState =>
    this.scopes.get(accountId) ?? EMPTY_STATE;

  /** Searches every loaded scope: an id can live in the unscoped page, an account-scoped one, or (once both are loaded) both at once. */
  get(id: string | null | undefined): LibraryItem | null {
    if (!id) return null;
    for (const state of this.scopes.values()) {
      const found = state.items.get(id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Loads the first time and never again for a given scope, so mounting a
   * screen costs nothing. `accountId` scopes the fetch to one account's
   * items; omitting it (as every caller but the open editor does) asks for
   * the unscoped, cross-account page. A scope not loaded yet — including one
   * some OTHER scope's load already resolved — fetches its own page, since
   * the last page fetched for a different scope may not even contain this
   * scope's items (LIBRARY_PAGE_SIZE is one page of the whole library,
   * ordered by recency across every account).
   *
   * "Loaded" is `installedRequest`, not merely `scopes.has(accountId)`:
   * remember() (below) can plant a scope's state early — a background just
   * uploaded, before anything has fetched a real page for that scope — and
   * that must not read as "already loaded" here, or the real page never
   * gets fetched at all. `installedRequest` is set only inside refresh()'s
   * own successful `.then()`, exactly the event this needs to key on.
   */
  load(accountId?: string): Promise<LibraryIndex> {
    if (this.installedRequest.has(accountId)) {
      return Promise.resolve(this.scopes.get(accountId)?.items ?? EMPTY);
    }
    return this.refresh(accountId);
  }

  /**
   * Reads the library afresh, for `accountId`'s scope. A caller arriving
   * mid-flight on the *same* scope waits on that one; a different scope
   * starts its own request rather than waiting on (or being overwritten by)
   * one for the wrong account.
   */
  refresh(accountId?: string): Promise<LibraryIndex> {
    const existingPending = this.pending.get(accountId);
    if (existingPending) return existingPending;
    const request = ++this.latestRequest;
    const current = this.scopes.get(accountId) ?? EMPTY_STATE;
    this.publish(accountId, { ...current, loading: true });
    // Built rather than passed as `{ limit, account: accountId }` directly:
    // exactOptionalPropertyTypes rejects an explicit `account: undefined` for
    // the unscoped case, which must instead omit the key entirely.
    const query: LibraryQuery =
      accountId === undefined
        ? { limit: LIBRARY_PAGE_SIZE }
        : { limit: LIBRARY_PAGE_SIZE, account: accountId };
    // Called inside its own try/catch rather than straight into `.then()`:
    // a real client that throws SYNCHRONOUSLY (a missing method, a
    // transport that blows up before ever returning a promise) would
    // otherwise throw right here — refresh() is not `async`, so that throw
    // would propagate straight out to whoever called load()/refresh() (an
    // effect, in the common case) instead of landing in this scope's own
    // `error`, the way a rejected listLibrary() already does. Converting it
    // to Promise.reject(error) here still calls the client SYNCHRONOUSLY,
    // in the same tick as every other caller of refresh() (some tests time
    // a screen-close against exactly when this call runs), while still
    // letting the `.catch()` below catch it like any other rejection.
    let initial: ReturnType<LibraryClient["listLibrary"]>;
    try {
      initial = this.client.listLibrary(query);
    } catch (error) {
      initial = Promise.reject(error);
    }
    const promise = initial
      .then(({ items }) => {
        if ((this.installedRequest.get(accountId) ?? 0) > request) {
          return this.scopes.get(accountId)?.items ?? EMPTY;
        }
        this.installedRequest.set(accountId, request);
        const index: LibraryIndex = new Map(items.map((item) => [item.id, item]));
        this.publish(accountId, { items: index, loading: false, error: null });
        return index;
      })
      .catch((error: unknown) => {
        // A library that cannot be read leaves the last good copy in place: a
        // dropped request must not blank every thumbnail on screen.
        if ((this.installedRequest.get(accountId) ?? 0) > request) {
          return this.scopes.get(accountId)?.items ?? EMPTY;
        }
        const previous = this.scopes.get(accountId) ?? EMPTY_STATE;
        this.publish(accountId, { ...previous, loading: false, error });
        return previous.items;
      })
      .finally(() => {
        if (this.pending.get(accountId) === promise) this.pending.delete(accountId);
      });
    this.pending.set(accountId, promise);
    return promise;
  }

  /**
   * Marks every scope — every one already loaded, and any not loaded yet —
   * as needing a fresh fetch on its next `load()` call, without discarding
   * what is cached now (a caller that wants that gone immediately still has
   * `refresh()` for the scope it knows about). One caller needs this today:
   * the e2e harness's openApp(), which reuses this module's one singleton
   * across every test in a file and has to guarantee the NEXT mount reads
   * fresh data for whichever scope it turns out to need — including a
   * scope an EARLIER test in the same file already loaded, which
   * `refresh()`'s own unscoped call does not touch now that scopes no
   * longer evict each other (see the class doc comment above).
   */
  invalidate(): void {
    this.installedRequest.clear();
  }

  /**
   * Folds a freshly uploaded or edited item in, the way rememberItem did —
   * so `get()` resolves it without awaiting, even for a scope that has never
   * been `load()`ed (a background just uploaded through the picker, say,
   * before anything has fetched a page that would include it). Written into
   * every scope that could hold it — the unscoped page (which holds every
   * account's items) and the scope for the item's own account — creating
   * that scope's state on demand rather than requiring it to already exist,
   * the way a single unconditional `this.state` always did before this was
   * split per scope.
   */
  remember(item: LibraryItem): void {
    for (const accountId of [undefined, item.accountId] as const) {
      const current = this.scopes.get(accountId) ?? EMPTY_STATE;
      const items = new Map(current.items);
      items.set(item.id, item);
      this.publish(accountId, { ...current, items });
    }
  }

  /** Dropped from every loaded scope: which account it belonged to is not tracked once gone, so every scope is checked rather than guessed at. */
  forget(id: string): void {
    for (const [accountId, current] of this.scopes) {
      if (!current.items.has(id)) continue;
      const items = new Map(current.items);
      items.delete(id);
      this.publish(accountId, { ...current, items });
    }
  }

  private publish(accountId: string | undefined, next: LibraryState): void {
    this.scopes.set(accountId, next);
    for (const listener of this.listeners) listener();
  }
}

/** One cache for the app. A test builds its own rather than sharing this. */
export const libraryCache = new LibraryCache();

/**
 * `accountId` scopes the load to one account, for the editor of a slideshow
 * that belongs to it. Omitted, this is the unscoped whole-library read every
 * other screen wants.
 *
 * `ready` (default true) lets a caller that has not yet resolved its own
 * scope skip firing a load at all, rather than firing an unscoped one it
 * knows it will immediately discard. The editor is the one caller that needs
 * this: on its first render the slideshow (and so its accountId) has not
 * loaded yet, and without `ready: false` that instant fired a full 200-item
 * unscoped, stats-joined query purely to throw the answer away the moment
 * the real, scoped accountId became known a render or two later.
 */
export function useLibrary(
  cache: LibraryCache = libraryCache,
  accountId?: string,
  ready = true,
): LibraryState {
  const state = useSyncExternalStore(cache.subscribe, () => cache.getSnapshot(accountId));
  useEffect(() => {
    if (!ready) return;
    void cache.load(accountId);
  }, [cache, accountId, ready]);
  return state;
}
