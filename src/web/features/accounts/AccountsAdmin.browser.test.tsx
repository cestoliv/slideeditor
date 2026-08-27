import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Account, FontEntry } from "@shared/schema/index.js";
import { TEXT_WEIGHT } from "@shared/text/index.js";
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../app/accounts.js";
import type { AccountsClient } from "../../app/accounts.js";
import { ApiError } from "../../app/api.js";
import { injectFontFaces, weightFor } from "../../app/fontFaces.js";
import { AccountsAdmin } from "./AccountsAdmin.js";

function defaults(overrides: Partial<Account["defaults"]> = {}): Account["defaults"] {
  return {
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
    ...overrides,
  };
}

function account(
  id: string,
  name: string,
  over: Partial<Account["defaults"]> = {},
): Account {
  return { id, name, defaults: defaults(over), createdAt: 1, updatedAt: 1 };
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

function fakeClient(
  accounts: Account[],
  fonts: FontEntry[],
): AccountsClient & {
  created: { name: string; defaults: Account["defaults"] }[];
  updated: { id: string; input: Partial<Account> }[];
  deleted: string[];
  fontsList: FontEntry[];
} {
  const fake = {
    created: [] as { name: string; defaults: Account["defaults"] }[],
    updated: [] as { id: string; input: Partial<Account> }[],
    deleted: [] as string[],
    fontsList: fonts,
    listAccounts: () => Promise.resolve({ accounts: fake.list }),
    listFonts: () => Promise.resolve({ fonts: fake.fontsList, dropped: [] }),
    createAccount: (input: { name: string; defaults: Account["defaults"] }) => {
      fake.created.push(input);
      const created = account(
        `new-${String(fake.created.length)}`,
        input.name,
        input.defaults,
      );
      fake.list = [...fake.list, created];
      return Promise.resolve({ account: created });
    },
    updateAccount: (id: string, input: Partial<Account>) => {
      fake.updated.push({ id, input });
      const current = fake.list.find((item) => item.id === id);
      if (current === undefined) throw new Error("unknown account in test");
      const merged: Account = {
        ...current,
        name: input.name ?? current.name,
        defaults: input.defaults ?? current.defaults,
      };
      fake.list = fake.list.map((item) => (item.id === id ? merged : item));
      return Promise.resolve({ account: merged });
    },
    deleteAccount: (id: string) => {
      fake.deleted.push(id);
      fake.list = fake.list.filter((item) => item.id !== id);
      return Promise.resolve({ removed: id });
    },
    addGoogleFont: unused<{ font: FontEntry }>(),
    deleteFont: (id: string) => {
      fake.fontsList = fake.fontsList.filter((entry) => entry.id !== id);
      return Promise.resolve();
    },
    list: accounts,
  };
  return fake;
}

function mount(client: AccountsClient) {
  const store = new AccountsStore(client);
  return render(
    <MemoryRouter initialEntries={["/accounts"]}>
      <ToastProvider>
        <AccountsProvider store={store}>
          <Routes>
            <Route path="/accounts" element={<AccountsAdmin store={store} />} />
          </Routes>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  document.querySelectorAll("style[data-fonts]").forEach((style) => {
    style.remove();
  });
  vi.unstubAllGlobals();
});

it("lists every account by name", async () => {
  const client = fakeClient(
    [account("a1", "Main brand"), account("a2", "Side project")],
    [font("f1", "TikTok Sans")],
  );
  const screen = await mount(client);
  await expect
    .element(screen.getByRole("button", { name: "Main brand", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Side project", exact: true }))
    .toBeVisible();
});

/*
 * Finding 6: AccountsAdmin's `store` prop is what every mutation (create,
 * update, remove, addGoogleFont, removeFont) went through, while the list on
 * screen used to come from useAccounts(), which resolves whatever store the
 * surrounding <AccountsProvider> holds. The two used to agree only because
 * every real mount (and every other test here) passes the same store to
 * both — this mounts them with two DIFFERENT stores on purpose, the shape
 * the `store` prop's own doc comment invites a test to take, to prove a
 * mutation through the prop's store is now what the list on screen reflects
 * rather than a silently dead form.
 */
it("reads and writes through the same store even when the surrounding provider holds a different one", async () => {
  const providerClient = fakeClient([], [font("f1", "TikTok Sans")]);
  const providerStore = new AccountsStore(providerClient);
  const propClient = fakeClient([], [font("f1", "TikTok Sans")]);
  const propStore = new AccountsStore(propClient);

  const screen = await render(
    <MemoryRouter initialEntries={["/accounts"]}>
      <ToastProvider>
        <AccountsProvider store={providerStore}>
          <Routes>
            <Route path="/accounts" element={<AccountsAdmin store={propStore} />} />
          </Routes>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

  await userEvent.fill(screen.getByLabelText("Name"), "New brand");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));

  // Landed on the store the form actually submits through...
  await expect.poll(() => propClient.created.length).toBe(1);
  // ...and shows up on screen, meaning the list read the same store rather
  // than the provider's separate, still-empty one.
  await expect
    .element(screen.getByRole("button", { name: "New brand", exact: true }))
    .toBeVisible();
  expect(providerClient.created).toHaveLength(0);
});

it("creates a new account from the form", async () => {
  const client = fakeClient([], [font("f1", "TikTok Sans")]);
  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Name"), "New brand");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await expect.poll(() => client.created.length).toBe(1);
  expect(client.created[0]?.name).toBe("New brand");
  expect(client.created[0]?.defaults.ratio).toEqual({ w: 9, h: 16 });
});

/*
 * Finding 6 from the multi-account review: save() never moved editingId onto
 * the account it had just created, so the button kept reading "Create
 * account" — there is no UNIQUE constraint on name to catch a second press
 * making a second, identically named account.
 */
it("saves an edit rather than creating a second account when the create button is pressed again", async () => {
  const client = fakeClient([], [font("f1", "TikTok Sans")]);
  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Name"), "New brand");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await expect.poll(() => client.created.length).toBe(1);

  // The button now reads "Save account", naming the account it just made.
  await expect
    .element(screen.getByRole("button", { name: "Save account" }))
    .toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Save account" }));
  await expect.poll(() => client.updated.length).toBe(1);
  expect(client.updated[0]?.id).toBe("new-1");
  // Still exactly one account created, not two.
  expect(client.created).toHaveLength(1);
});

/*
 * Finding 6's second half: the "Add a Google font" input sits inside the
 * account <form>, so Enter there used to implicitly submit it (the
 * browser's default target for Enter in a form with no other focused submit
 * control) and create or save an account by accident instead of adding the
 * font.
 */
it("adds a Google font on Enter instead of submitting the account form", async () => {
  const client = fakeClient([], [font("f1", "TikTok Sans")]);
  let added: string | null = null;
  client.addGoogleFont = (family: string) => {
    added = family;
    return Promise.resolve({ font: font("f2", family) });
  };
  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Name"), "New brand");
  await userEvent.fill(screen.getByLabelText("Add a Google font"), "Bebas Neue");
  await userEvent.keyboard("{Enter}");

  await expect.poll(() => added).toBe("Bebas Neue");
  expect(client.created).toHaveLength(0);
  expect(client.updated).toHaveLength(0);
});

/*
 * Finding 3 from the multi-account review: crypto.randomUUID() is
 * secure-context-gated and undefined on a plain-HTTP non-localhost origin -
 * exactly what the README's --host 0.0.0.0 and the Docker image's bind
 * produce. AccountPreview's useMemo used to call it (through newTextLayer's
 * own default id generator) on every render, so opening /accounts there
 * threw during render and blanked the whole screen.
 */
it("renders the account preview without crypto.randomUUID", async () => {
  vi.stubGlobal("crypto", { ...crypto, randomUUID: undefined });
  const client = fakeClient([], [font("f1", "TikTok Sans")]);
  const screen = await mount(client);
  await expect
    .element(screen.getByRole("button", { name: "Create account" }))
    .toBeVisible();
});

/*
 * Finding 7 from the multi-account review: the form offered every text
 * default except size, even though text no longer shrinks to fit
 * (compose.ts's size ladder is gone) and size is now the main lever an
 * account has for keeping a long slide's text on screen. There was no way to
 * change it at all.
 */
it("saves a chosen text size as part of the account's defaults", async () => {
  const client = fakeClient([], [font("f1", "TikTok Sans")]);
  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Name"), "New brand");
  await userEvent.fill(screen.getByLabelText("Font size in pixels"), "88");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await expect.poll(() => client.created.length).toBe(1);
  expect(client.created[0]?.defaults.text.size).toBe(88);
});

it("loads an existing account's defaults and saves changes to it", async () => {
  const client = fakeClient(
    [account("a1", "Main brand", { text: { ...defaults().text, style: "plain" } })],
    [font("f1", "TikTok Sans")],
  );
  const screen = await mount(client);
  await userEvent.click(screen.getByRole("button", { name: "Main brand", exact: true }));
  await expect.element(screen.getByLabelText("Name")).toHaveValue("Main brand");

  await userEvent.click(screen.getByRole("button", { name: "Save account" }));
  await expect.poll(() => client.updated.length).toBe(1);
  expect(client.updated[0]?.id).toBe("a1");
});

/*
 * Finding 2 from the delete/dirty-form review: switching the form to another
 * account used to overwrite name/draft with no dirty check at all, so an
 * in-progress edit vanished the moment another row was clicked. This proves
 * the fix — per-account drafts — round trips: an edit survives a trip away
 * and back, with no dialog involved.
 */
it("keeps an unsaved edit when the form switches to another account and back", async () => {
  const client = fakeClient(
    [account("a1", "Main brand"), account("a2", "Side project")],
    [font("f1", "TikTok Sans")],
  );
  const screen = await mount(client);

  await userEvent.click(screen.getByRole("button", { name: "Main brand", exact: true }));
  await expect.element(screen.getByLabelText("Name")).toHaveValue("Main brand");
  await userEvent.fill(screen.getByLabelText("Name"), "Main brand (draft)");

  await userEvent.click(
    screen.getByRole("button", { name: "Side project", exact: true }),
  );
  await expect.element(screen.getByLabelText("Name")).toHaveValue("Side project");

  await userEvent.click(screen.getByRole("button", { name: "Main brand", exact: true }));
  await expect.element(screen.getByLabelText("Name")).toHaveValue("Main brand (draft)");

  // Nothing was saved along the way.
  expect(client.updated).toEqual([]);
});

/*
 * Finding 1 from the same review: there was no delete control at all, even
 * though the store's remove() and the server's 409 both already existed.
 */
it("deletes an empty account", async () => {
  const client = fakeClient(
    [account("a1", "Main brand"), account("a2", "Side project")],
    [font("f1", "TikTok Sans")],
  );
  const screen = await mount(client);

  await userEvent.click(screen.getByRole("button", { name: "Delete Side project" }));

  await expect.element(screen.getByText("Side project deleted")).toBeVisible();
  expect(client.deleted).toEqual(["a2"]);
  await expect
    .element(screen.getByRole("button", { name: "Side project" }))
    .not.toBeInTheDocument();
});

it("surfaces the server's reason, with its counts, when a non-empty account can't be deleted", async () => {
  const client = fakeClient(
    [account("a1", "Main brand"), account("a2", "Side project")],
    [font("f1", "TikTok Sans")],
  );
  client.deleteAccount = () =>
    Promise.reject(
      new ApiError(409, "This account still owns 2 slideshows and 1 library item.", {
        projects: 2,
        items: 1,
      }),
    );
  const screen = await mount(client);

  await userEvent.click(screen.getByRole("button", { name: "Delete Side project" }));

  await expect
    .element(screen.getByText("This account still owns 2 slideshows and 1 library item."))
    .toBeVisible();
  // Refused, not swallowed: the account is still there and nothing cascaded.
  await expect
    .element(screen.getByRole("button", { name: "Side project", exact: true }))
    .toBeVisible();
});

it("won't let the last account be deleted", async () => {
  const client = fakeClient([account("a1", "Only brand")], [font("f1", "TikTok Sans")]);
  const screen = await mount(client);

  await expect
    .element(
      screen.getByRole("button", {
        name: "Only brand is the only account and can’t be deleted",
      }),
    )
    .toBeDisabled();
});

it("adds a Google font and refreshes the catalogue it offers", async () => {
  const client = fakeClient([account("a1", "Main brand")], [font("f1", "TikTok Sans")]);
  let added: string | null = null;
  client.addGoogleFont = (family: string) => {
    added = family;
    return Promise.resolve({ font: font("f2", family) });
  };
  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Add a Google font"), "Bebas Neue");
  await userEvent.click(screen.getByRole("button", { name: "Add font" }));
  await expect.poll(() => added).toBe("Bebas Neue");
});

/*
 * Task 12's review flagged this exact trap: nothing re-runs injectFontFaces()
 * after the sign-in that first calls it, so a family added here would sit in
 * useAccounts().fonts and the picker with no @font-face rule behind it —
 * weightFor() would keep answering the TEXT_WEIGHT fallback until a full
 * reload. A test that only checked the picker listed the new family would
 * pass either way, so this asserts the real signal instead: weightFor()
 * answers the family's true catalogued weight right after the add resolves,
 * with no reload in between.
 */
it("makes an added Google font usable immediately, with no reload", async () => {
  const client = fakeClient([account("a1", "Main brand")], [font("f1", "TikTok Sans")]);
  const addedFont: FontEntry = {
    id: "f2",
    family: "Bebas Neue",
    weight: 700,
    weightMin: null,
    weightMax: null,
    source: "google",
    url: `/media/f2.woff2`,
  };
  client.addGoogleFont = () => Promise.resolve({ font: addedFont });
  // Finding 11: injectFontFaces() no longer re-fetches /api/fonts itself once
  // AccountsStore.addGoogleFont()'s own refresh() already has the answer —
  // it installs directly from the store's snapshot instead (AccountsAdmin's
  // addFont()). So this is the one call that has to reflect the addition:
  // there is no second, independent /api/fonts round trip left to stub.
  client.listFonts = () =>
    Promise.resolve({ fonts: [font("f1", "TikTok Sans"), addedFont], dropped: [] });

  const screen = await mount(client);
  await userEvent.fill(screen.getByLabelText("Add a Google font"), "Bebas Neue");
  await userEvent.click(screen.getByRole("button", { name: "Add font" }));

  await expect.poll(() => weightFor("Bebas Neue")).toBe(700);
});

/*
 * The toast's own row. Radix also announces the message in a live region, so
 * a getByText for the words matches two nodes and fails strict mode whenever
 * that region is still mounted when the assertion runs.
 */
function toastText(): string {
  return [...document.querySelectorAll("ol > li")]
    .map((row) => row.textContent ?? "")
    .join(" | ");
}

/*
 * Finding 8 (fix round 4): a font entry the server sent but this client
 * could not parse used to be dropped with only a console.warn — a signal
 * nobody watches. AccountsAdmin is the screen where a missing font would
 * actually be noticed (the picker just has fewer entries than expected, with
 * no explanation), so it is what surfaces the warning to a person.
 */
it("toasts once when the font catalogue carries a dropped entry", async () => {
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

  await mount(client);
  await expect.poll(toastText).toContain("Broken Font");
});

function googleFont(id: string, family: string): FontEntry {
  return {
    id,
    family,
    weight: 400,
    weightMin: null,
    weightMax: null,
    source: "google",
    url: `/media/${id}.woff2`,
  };
}

/*
 * Finding 8: AccountsAdmin rendered fonts only as a read-only Select, with
 * no control anywhere that could ever reach AccountsStore.removeFont() /
 * DELETE /api/fonts/:id. A family added by typo — or simply no longer
 * wanted — had no way to be removed, ever, in production.
 */
it("offers no delete control for a builtin font, and one for a Google font", async () => {
  const client = fakeClient(
    [account("a1", "Main brand")],
    [font("f1", "TikTok Sans"), googleFont("f2", "Bebas Neue")],
  );
  const screen = await mount(client);

  await expect
    .element(screen.getByRole("button", { name: "Delete Bebas Neue" }))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Delete TikTok Sans" }).query()).toBeNull();
});

it("deletes a Google font and drops it from the list", async () => {
  const client = fakeClient(
    [account("a1", "Main brand")],
    [font("f1", "TikTok Sans"), googleFont("f2", "Bebas Neue")],
  );
  const screen = await mount(client);

  await userEvent.click(screen.getByRole("button", { name: "Delete Bebas Neue" }));

  await expect.poll(() => client.fontsList.map((f) => f.id)).toEqual(["f1"]);
  await expect
    .element(screen.getByRole("button", { name: "Delete Bebas Neue" }))
    .not.toBeInTheDocument();
  await expect.poll(toastText).toBe("Bebas Neue deleted");
});

/*
 * Finding 7: removeFont() dropped the row from the server and the store's
 * own snapshot, but never re-ran injectFontFaces() the way addFont() does —
 * so weightFor(deletedFamily) kept answering the deleted font's own weight,
 * and the injected <style> kept a rule pointing at the /media/<id>.woff2 the
 * server just unlinked, until a full reload. Mirrors "makes an added Google
 * font usable immediately" above: the real signal is weightFor(), not just
 * whether the picker still lists the family.
 */
it("stops answering the deleted font's weight immediately, with no reload", async () => {
  const bebas = googleFont("f2", "Bebas Neue");
  const client = fakeClient(
    [account("a1", "Main brand")],
    [font("f1", "TikTok Sans"), bebas],
  );
  // Seeds the catalogue the way sign-in's own injectFontFaces() call would
  // have, before this test's actual subject — removeFont() — runs.
  await injectFontFaces([font("f1", "TikTok Sans"), bebas]);
  const screen = await mount(client);
  await expect.poll(() => weightFor("Bebas Neue")).toBe(400);

  await userEvent.click(screen.getByRole("button", { name: "Delete Bebas Neue" }));

  await expect.poll(() => weightFor("Bebas Neue")).toBe(TEXT_WEIGHT);
});

/*
 * Finding 8: FontInUseError's own message already names what still uses the
 * family (fonts.ts: "X is still used by N accounts or slideshows"), so
 * deleting one that is in use has to surface that 409 message rather than a
 * generic failure — mirrors the account delete control's own remove().
 */
it("surfaces the server's in-use message when a Google font delete 409s", async () => {
  const client = fakeClient(
    [account("a1", "Main brand")],
    [font("f1", "TikTok Sans"), googleFont("f2", "Bebas Neue")],
  );
  client.deleteFont = () =>
    Promise.reject(
      new ApiError(409, "Bebas Neue is still used by 1 account.", {
        error: "Bebas Neue is still used by 1 account.",
      }),
    );
  const screen = await mount(client);

  await userEvent.click(screen.getByRole("button", { name: "Delete Bebas Neue" }));

  await expect.poll(toastText).toBe("Bebas Neue is still used by 1 account.");
  // Refused server-side: the row is still there.
  await expect
    .element(screen.getByRole("button", { name: "Delete Bebas Neue" }))
    .toBeVisible();
});

/*
 * Finding 9: addFont()'s catch discarded whatever the server actually said —
 * "Google Fonts had no family named X", "X has no Latin character set
 * available", "X's font URL was not on Google's font CDN" are three
 * distinct, actionable failures, and a typo used to read identically to a
 * network error. Mirrors removeFont() (and the account form's own remove())
 * in surfacing ApiError's message as-is.
 */
it("surfaces the server's exact reason when adding a Google font fails", async () => {
  const client = fakeClient([account("a1", "Main brand")], [font("f1", "TikTok Sans")]);
  client.addGoogleFont = () =>
    Promise.reject(
      new ApiError(404, "Google Fonts had no family named Not A Real Font.", {
        error: "Google Fonts had no family named Not A Real Font.",
      }),
    );
  const screen = await mount(client);

  await userEvent.fill(screen.getByLabelText("Add a Google font"), "Not A Real Font");
  await userEvent.click(screen.getByRole("button", { name: "Add font" }));

  await expect.poll(toastText).toBe("Google Fonts had no family named Not A Real Font.");
});
