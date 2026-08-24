import { useEffect, useSyncExternalStore } from "react";
import type { LibraryItem } from "@shared/schema/index.js";
import { api } from "./api.js";

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

export class LibraryCache {
  private state: LibraryState = { items: EMPTY, loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  private inFlight: Promise<LibraryIndex> | null = null;
  private loaded = false;

  constructor(private readonly client: LibraryClient = api) {}

  /* Bound as fields, because useSyncExternalStore resubscribes on a new identity. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LibraryState => this.state;

  get(id: string | null | undefined): LibraryItem | null {
    if (!id) return null;
    return this.state.items.get(id) ?? null;
  }

  /** Loads the first time and never again, so mounting a screen costs nothing. */
  load(): Promise<LibraryIndex> {
    if (this.loaded) return Promise.resolve(this.state.items);
    return this.refresh();
  }

  /** Reads the library afresh. A caller arriving mid-flight waits on that one. */
  refresh(): Promise<LibraryIndex> {
    if (this.inFlight !== null) return this.inFlight;
    this.publish({ ...this.state, loading: true });
    const request = this.client
      .listLibrary({ limit: LIBRARY_PAGE_SIZE })
      .then(({ items }) => {
        this.loaded = true;
        const index: LibraryIndex = new Map(items.map((item) => [item.id, item]));
        this.publish({ items: index, loading: false, error: null });
        return index;
      })
      .catch((error: unknown) => {
        // A library that cannot be read leaves the last good copy in place: a
        // dropped request must not blank every thumbnail on screen.
        this.publish({ ...this.state, loading: false, error });
        return this.state.items;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  /** Folds a freshly uploaded or edited item in, the way rememberItem did. */
  remember(item: LibraryItem): void {
    const items = new Map(this.state.items);
    items.set(item.id, item);
    this.publish({ ...this.state, items });
  }

  forget(id: string): void {
    if (!this.state.items.has(id)) return;
    const items = new Map(this.state.items);
    items.delete(id);
    this.publish({ ...this.state, items });
  }

  private publish(next: LibraryState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** One cache for the app. A test builds its own rather than sharing this. */
export const libraryCache = new LibraryCache();

export function useLibrary(cache: LibraryCache = libraryCache): LibraryState {
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => {
    void cache.load();
  }, [cache]);
  return state;
}
