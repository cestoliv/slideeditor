import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { Account, FontEntry } from "@shared/schema/index.js";
import { AccountsProvider, AccountsStore, useAccounts } from "./accounts.js";
import type { AccountsClient } from "./accounts.js";

function account(id: string, name: string): Account {
  return {
    id,
    name,
    defaults: {
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "TikTok Sans",
        size: 64,
        style: "plain",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function font(id: string, family: string): FontEntry {
  return {
    id,
    family,
    weight: 500,
    weightMin: null,
    weightMax: null,
    source: "builtin",
    url: `/fonts/${id}.woff2`,
  };
}

function unused<T>(): () => Promise<T> {
  return () => Promise.reject(new Error("not used by this test"));
}

function Names() {
  const { accounts, fonts } = useAccounts();
  return (
    <p>
      {accounts.map((item) => item.name).join(", ") || "none"} ·{" "}
      {fonts.map((item) => item.family).join(", ") || "none"}
    </p>
  );
}

it("loads accounts and fonts once for every screen that reads them", async () => {
  let calls = 0;
  const client: AccountsClient = {
    listAccounts: () => {
      calls += 1;
      return Promise.resolve({ accounts: [account("a1", "Main brand")] });
    },
    listFonts: () => Promise.resolve({ fonts: [font("f1", "TikTok Sans")], dropped: [] }),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);
  const screen = await render(
    <AccountsProvider store={store}>
      <Names />
    </AccountsProvider>,
  );
  await expect.element(screen.getByText("Main brand · TikTok Sans")).toBeVisible();
  // Once, not once per reader: two mounts of Names would double this if the
  // provider re-fetched on every subscribe rather than once on its own mount.
  expect(calls).toBe(1);
});

it("republishes the list once a new account is created", async () => {
  let stored: Account[] = [account("a1", "Main brand")];
  const client: AccountsClient = {
    listAccounts: () => Promise.resolve({ accounts: stored }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: (input) => {
      const created = account("a2", input.name);
      stored = [...stored, created];
      return Promise.resolve({ account: created });
    },
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);
  const screen = await render(
    <AccountsProvider store={store}>
      <Names />
    </AccountsProvider>,
  );
  await expect.element(screen.getByText(/Main brand/)).toBeVisible();

  await store.create({ name: "Second brand", defaults: account("x", "x").defaults });
  await expect.element(screen.getByText("Main brand, Second brand · ")).toBeVisible();
});

/*
 * Finding 12 from the multi-account review: useAccounts() returned
 * [...state.accounts] and [...state.fonts] — fresh arrays every render, even
 * though the store's own getSnapshot only ever replaces state wholesale
 * (publish()). The copy defeated every identity check downstream: Dashboard's
 * stale-filter effect (`useEffect(..., [accounts])`) fired on every render of
 * Dashboard itself rather than only when the account list actually changed.
 */
it("keeps the same accounts and fonts array references across a render the store did not cause", async () => {
  const client: AccountsClient = {
    listAccounts: () => Promise.resolve({ accounts: [account("a1", "Main brand")] }),
    listFonts: () => Promise.resolve({ fonts: [font("f1", "TikTok Sans")], dropped: [] }),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);
  const seenAccounts: (readonly Account[])[] = [];
  const seenFonts: (readonly FontEntry[])[] = [];

  function Probe() {
    const { accounts, fonts } = useAccounts();
    const [, forceRender] = useState(0);
    seenAccounts.push(accounts);
    seenFonts.push(fonts);
    return (
      <button
        onClick={() => {
          // A re-render this component caused itself, not one the store
          // published — exactly what used to defeat the identity check.
          forceRender((count) => count + 1);
        }}
      >
        rerender
      </button>
    );
  }

  const screen = await render(
    <AccountsProvider store={store}>
      <Probe />
    </AccountsProvider>,
  );
  // Waits past the load: the first render or two see the initial empty
  // snapshot, and comparing against one of those would trivially pass no
  // matter what useAccounts() does (a different empty array still is not the
  // one from the loaded snapshot).
  await expect.poll(() => seenAccounts.at(-1)?.length).toBe(1);
  const loadedAccounts = seenAccounts.at(-1);
  const loadedFonts = seenFonts.at(-1);
  const rendersBeforeClick = seenAccounts.length;

  await userEvent.click(screen.getByRole("button"));
  await expect.poll(() => seenAccounts.length).toBeGreaterThan(rendersBeforeClick);

  expect(seenAccounts.at(-1)).toBe(loadedAccounts);
  expect(seenFonts.at(-1)).toBe(loadedFonts);
});

/*
 * Finding 8 (fix round 4): a font entry the server sent but this client
 * could not parse used to be dropped with only a console.warn — a signal
 * nobody watches. `fontWarnings` is what lets a screen (AccountsAdmin.tsx)
 * actually put it in front of someone, rather than the font silently
 * vanishing from the picker with no id left to delete it by.
 */
it("surfaces a dropped font entry through fontWarnings", async () => {
  const client: AccountsClient = {
    listAccounts: () => Promise.resolve({ accounts: [account("a1", "Main brand")] }),
    listFonts: () =>
      Promise.resolve({
        fonts: [font("f1", "TikTok Sans")],
        dropped: [{ label: "Broken Font", issue: "Invalid enum value" }],
      }),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);

  function Warnings() {
    const { fontWarnings } = useAccounts();
    return <p>{fontWarnings.map((warning) => warning.label).join(", ") || "none"}</p>;
  }

  const screen = await render(
    <AccountsProvider store={store}>
      <Warnings />
    </AccountsProvider>,
  );
  await expect.element(screen.getByText("Broken Font")).toBeVisible();
});

/*
 * Finding 4: `Promise.all` used to make a rejected `/api/fonts` skip the
 * whole publish, so a resolved `/api/accounts` sitting right beside it in
 * the pair was discarded too — `accounts` stayed at `[]` and `error` was
 * set, which `LibraryAdmin.tsx`/`Editor.tsx` both read as "the accounts
 * list itself failed to load". The two must settle independently: a fonts
 * failure alone should publish the accounts that did load, and leave
 * `error` unset.
 */
it("still publishes accounts when only the fonts fetch fails", async () => {
  const client: AccountsClient = {
    listAccounts: () => Promise.resolve({ accounts: [account("a1", "Main brand")] }),
    listFonts: () => Promise.reject(new Error("font endpoint is down")),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);

  function Probe() {
    const { accounts, error } = useAccounts();
    return (
      <p>
        {accounts.map((item) => item.name).join(", ") || "none"} ·{" "}
        {error === null ? "no-error" : "error"}
      </p>
    );
  }

  const screen = await render(
    <AccountsProvider store={store}>
      <Probe />
    </AccountsProvider>,
  );
  await expect.element(screen.getByText("Main brand · no-error")).toBeVisible();
});

/*
 * The mirror of the test above: an accounts fetch failure must not be
 * masked by a fonts fetch that happened to succeed, and it must still
 * publish whatever fonts came back.
 */
it("still publishes fonts and reports the error when only the accounts fetch fails", async () => {
  const client: AccountsClient = {
    listAccounts: () => Promise.reject(new Error("accounts endpoint is down")),
    listFonts: () => Promise.resolve({ fonts: [font("f1", "TikTok Sans")], dropped: [] }),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);

  function Probe() {
    const { fonts, error } = useAccounts();
    return (
      <p>
        {fonts.map((item) => item.family).join(", ") || "none"} ·{" "}
        {error === null ? "no-error" : "error"}
      </p>
    );
  }

  const screen = await render(
    <AccountsProvider store={store}>
      <Probe />
    </AccountsProvider>,
  );
  await expect.element(screen.getByText("TikTok Sans · error")).toBeVisible();
});

/*
 * A client method that throws SYNCHRONOUSLY (a missing method, a transport
 * that blows up before ever returning a promise) is not merely a rejected
 * promise: calling it happens while refresh() is still building the array it
 * hands to Promise.allSettled, before allSettled has any promise to settle
 * at all. That used to throw straight out of refresh() itself — an
 * `async` method, so the throw became a rejection of refresh()'s own
 * returned promise, which AccountsProvider's mount effect calls with
 * `void store.refresh()` and never awaits, so the rejection had nowhere to
 * land but the process as an unhandled rejection. A rejection here must
 * behave exactly like a rejected /api/accounts: recorded in `error`, not
 * escaping refresh() at all.
 */
it("records a synchronous throw from the client in error, rather than letting refresh() reject", async () => {
  const client: AccountsClient = {
    listAccounts: () => {
      throw new Error("listAccounts is not a function");
    },
    listFonts: () => Promise.resolve({ fonts: [font("f1", "TikTok Sans")], dropped: [] }),
    createAccount: unused(),
    updateAccount: unused(),
    deleteAccount: unused(),
    addGoogleFont: unused(),
    deleteFont: unused(),
  };
  const store = new AccountsStore(client);

  await expect(store.refresh()).resolves.toBeUndefined();

  const state = store.getSnapshot();
  expect(state.error).toBeInstanceOf(Error);
  expect(state.loading).toBe(false);
  // The fonts half settled independently and still published, exactly as a
  // rejected (rather than throwing) listAccounts already does above.
  expect(state.fonts.map((item) => item.family)).toEqual(["TikTok Sans"]);
});
