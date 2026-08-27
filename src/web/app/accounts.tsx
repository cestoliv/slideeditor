import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  Account,
  AccountDefaults,
  DroppedFontEntry,
  FontEntry,
} from "@shared/schema/index.js";
import { api } from "./api.js";

/*
 * The account catalogue and its fonts, loaded once at boot. Every screen that
 * needs a brand's defaults reads this rather than fetching its own copy,
 * mirroring ProjectsStore (src/web/app/projects.tsx) exactly: one store above
 * the router, a Provider that starts the load, and a hook that subscribes.
 *
 * useAccounts() hands back data only, not methods: a write goes through the
 * store instance directly (accountsStore.create(...) or an injected one in a
 * test), the same split LibraryCache keeps between useLibrary's reads and the
 * cache's own remember()/forget().
 *
 * This fetches /api/fonts on its own rather than reading fontFaces.ts's
 * module-level catalogue. That catalogue is a private cache built for a
 * different job — injecting <style> @font-face rules and answering
 * weightFor() before React mounts — with no subscription mechanism and no
 * way to inject a fake client for a test. Wiring AccountsStore to it would
 * mean exposing internal state from an unrelated module just to save one
 * request. The fonts list changes rarely, so the duplicate GET at boot is
 * cheap; keeping the two concerns apart is worth more than the request it
 * costs.
 */

export type AccountsClient = Pick<
  typeof api,
  | "listAccounts"
  | "createAccount"
  | "updateAccount"
  | "deleteAccount"
  | "listFonts"
  | "addGoogleFont"
  | "deleteFont"
>;

export type AccountsState = {
  accounts: readonly Account[];
  fonts: readonly FontEntry[];
  /**
   * A font entry the last refresh() could not use — see DroppedFontEntry's
   * own doc comment (shared/schema/font.ts) for why this exists at all.
   * AccountsAdmin.tsx is what actually puts it in front of someone.
   */
  fontWarnings: readonly DroppedFontEntry[];
  loading: boolean;
  /**
   * Set only by a failed `/api/accounts`, not a failed `/api/fonts` — see
   * refresh()'s own comment. `LibraryAdmin.tsx` and `Editor.tsx` both read
   * this as "the account list itself could not be loaded", and a font
   * endpoint outage is a different, unrelated failure that must not read
   * that way: it would disable New slideshow and blank the dashboard's
   * account picker over a fetch neither of them needed to succeed.
   */
  error: unknown;
};

export class AccountsStore {
  private state: AccountsState = {
    accounts: [],
    fonts: [],
    fontWarnings: [],
    loading: true,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  /** Every read is numbered, so a slow answer cannot overwrite a newer one. */
  private latest = 0;

  constructor(private readonly client: AccountsClient = api) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AccountsState => this.state;

  /**
   * Accounts and fonts load together — the admin form needs both at once —
   * but they must settle independently: `Promise.all` used to make one
   * rejection skip the publish entirely, so a 500 or a timeout on
   * `/api/fonts` left `accounts` at whatever it already was (`[]` on a cold
   * boot) even though `/api/accounts` had already answered successfully and
   * sat right there in the resolved half of the pair. `LibraryAdmin` then
   * disabled New slideshow, the dashboard's account Select went empty, the
   * font picker went empty, and the editor toasted about its account's
   * style — four unrelated screens taken down by one endpoint. `allSettled`
   * lets each half publish (or, on failure, leave the previous state
   * exactly as a failed `refresh()` already did) on its own outcome.
   */
  refresh = async (): Promise<void> => {
    const request = this.latest + 1;
    this.latest = request;
    // Each call is wrapped in its own async closure rather than invoked
    // directly in the array literal: a real client that throws
    // SYNCHRONOUSLY (a missing method, a transport that blows up before
    // ever returning a promise — exactly what a stale fake client did here)
    // would otherwise throw while this array is being built, before
    // Promise.allSettled ever receives a promise to settle. That throw
    // happens inside this `async` method's body, so it does not surface to
    // the caller as a normal exception either — it turns refresh()'s own
    // returned promise into a rejection, which every caller here awaits
    // with `void`, so it would escape as an unhandled rejection instead of
    // landing in `error` the way a rejected /api/accounts or /api/fonts
    // already does. Wrapping each call in `(async () => ...)()` forces even
    // a synchronous throw to surface as that one call's own rejection, so
    // allSettled still sees two real promises and the two endpoints still
    // settle independently.
    const [accountsResult, fontsResult] = await Promise.allSettled([
      (async () => this.client.listAccounts())(),
      (async () => this.client.listFonts())(),
    ]);
    if (this.latest !== request) return;

    const next: AccountsState = { ...this.state, loading: false };
    if (accountsResult.status === "fulfilled") {
      next.accounts = accountsResult.value.accounts;
      // Cleared on ANY successful accounts fetch, even one alongside a
      // failed fonts fetch: `error` means "the accounts list itself could
      // not be loaded" to every reader (see its own doc comment), and that
      // is no longer true the moment this succeeds.
      next.error = null;
    } else {
      next.error = accountsResult.reason;
    }
    if (fontsResult.status === "fulfilled") {
      next.fonts = fontsResult.value.fonts;
      next.fontWarnings = fontsResult.value.dropped;
    } else {
      // Nothing reads a fonts-fetch failure off this store today (unlike a
      // dropped/malformed row, which fontWarnings surfaces on purpose) —
      // logged so it is not silently swallowed, and `fonts`/`fontWarnings`
      // are left exactly as they were rather than blanked.
      console.error(fontsResult.reason);
    }
    this.publish(next);
  };

  create = async (input: {
    name: string;
    defaults: AccountDefaults;
  }): Promise<Account> => {
    const { account } = await this.client.createAccount(input);
    await this.refresh();
    return account;
  };

  update = async (
    id: string,
    input: { name?: string; defaults?: AccountDefaults },
  ): Promise<Account> => {
    const { account } = await this.client.updateAccount(id, input);
    await this.refresh();
    return account;
  };

  remove = async (id: string): Promise<void> => {
    await this.client.deleteAccount(id);
    await this.refresh();
  };

  addGoogleFont = async (family: string): Promise<FontEntry> => {
    const { font } = await this.client.addGoogleFont(family);
    await this.refresh();
    return font;
  };

  removeFont = async (id: string): Promise<void> => {
    await this.client.deleteFont(id);
    await this.refresh();
  };

  private publish(next: AccountsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** One store for the app. A test builds its own rather than sharing this. */
export const accountsStore = new AccountsStore();

const AccountsContext = createContext<AccountsStore | null>(null);

export type AccountsProviderProps = {
  children: ReactNode;
  /* Defaults to the module binding, whose identity is stable across renders. */
  store?: AccountsStore;
};

export function AccountsProvider({
  children,
  store = accountsStore,
}: AccountsProviderProps) {
  useEffect(() => {
    void store.refresh();
  }, [store]);

  return <AccountsContext.Provider value={store}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): {
  accounts: readonly Account[];
  fonts: readonly FontEntry[];
  fontWarnings: readonly DroppedFontEntry[];
  loading: boolean;
  error: unknown;
} {
  const store = useContext(AccountsContext);
  if (store === null) {
    throw new Error("useAccounts needs an <AccountsProvider> above it.");
  }
  // The store's own snapshot (getSnapshot = () => this.state) is only ever
  // replaced wholesale, by publish(), so state.accounts and state.fonts
  // already keep their identity across a render that changed neither. A copy
  // here bought nothing and cost every downstream memo an identity check: a
  // consumer keyed on accounts/fonts (Dashboard's stale-filter effect, say)
  // fired on every render of its own rather than only when the data changed.
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    accounts: state.accounts,
    fonts: state.fonts,
    fontWarnings: state.fontWarnings,
    loading: state.loading,
    error: state.error,
  };
}
