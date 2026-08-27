import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { page, userEvent } from "vitest/browser";
// The editor paints from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { BUILTIN_DEFAULTS, DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type {
  Account,
  LibraryItem,
  Project,
  SlideshowStatus,
} from "@shared/schema/index.js";
import { ToastProvider } from "../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../app/accounts.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { RETRY_LIMIT, RETRY_MAX_MS, SAVE_DEBOUNCE_MS } from "./persistence.js";
import type { ServerEvent } from "../../app/events.js";
import { Editor } from "./Editor.js";
import type { EditorClient } from "./Editor.js";
import { STALE_NOTICE_MS } from "./Editor.js";
import { fixtureProject } from "./testing.js";

type Fake = EditorClient & {
  saved: Project[];
  statuses: SlideshowStatus[];
  reads: number;
  answer: Project;
  /**
   * The very objects handed to the editor. EditorStore holds the document it is
   * given and mutates it in place, so the last one here is the live document,
   * which is the only way to read a field no control on screen shows yet. The
   * status switch is Task 16's.
   */
  handed: Project[];
};

function fakeClient(project: Project): Fake {
  const fake: Fake = {
    saved: [],
    statuses: [],
    reads: 0,
    answer: project,
    handed: [],
    getProject: () => {
      fake.reads += 1;
      // A fresh copy per read, the way a real GET answers.
      const copy = structuredClone(fake.answer);
      fake.handed.push(copy);
      return Promise.resolve({ project: copy });
    },
    save: (sent) => {
      fake.saved.push(structuredClone(sent));
      return Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 });
    },
    setStatus: (_id, status) => {
      fake.statuses.push(status);
      return Promise.resolve({});
    },
  };
  return fake;
}

function emptyLibrary(): LibraryCache {
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
  });
}

type CountedLibrary = { cache: LibraryCache; reads: () => number };

/**
 * A library that counts its reads. The reload path calls refresh() before its
 * first await, so this count moves synchronously with the event: a test can ask
 * whether a reload started without waiting to see whether one finished.
 */
function countingLibrary(): CountedLibrary {
  let reads = 0;
  const cache = new LibraryCache({
    listLibrary: () => {
      reads += 1;
      return Promise.resolve({ items: [], total: 0 });
    },
  });
  return { cache, reads: () => reads };
}

/*
 * The upload, replaced at the module boundary rather than injected through a
 * prop. Editor reaches for it through addSlides and backgrounds, and a prop
 * would have proved the test's own wiring instead of the app's.
 */
const uploads = vi.hoisted(() => ({
  seen: [] as string[],
  run: null as ((file: File) => Promise<LibraryItem>) | null,
}));

vi.mock("../library/upload.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../library/upload.js")>();
  return {
    ...original,
    uploadLibraryFile: (_kind: string, file: File) => {
      uploads.seen.push(file.name);
      return (uploads.run ?? defaultUpload)(file);
    },
  };
});

function libraryItemFor(id: string): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

function defaultUpload(file: File): Promise<LibraryItem> {
  // The server names what it stores after the file, minus its extension
  // (nameForFile in features/library/upload.ts), and a slide takes the name of
  // its background. A fake that skipped that would prove the wrong name.
  return Promise.resolve({
    ...libraryItemFor(`item-${file.name}`),
    name: file.name.replace(/\.[^.]+$/, ""),
  });
}

beforeEach(() => {
  uploads.seen = [];
  uploads.run = null;
});

/** The live document, which EditorStore holds and mutates in place. */
function live(client: Fake): Project {
  const held = client.handed.at(-1);
  if (held === undefined) throw new Error("The editor opened no slideshow.");
  return held;
}

type MountOptions = {
  client: EditorClient;
  subscribe?: (onEvent: (event: ServerEvent) => void) => () => void;
  library?: LibraryCache;
  /** Defaults to one account matching the fixture's own accountId. */
  accounts?: Account[];
  /** A caller that needs its own listAccounts (slow, failing) passes this instead. */
  accountsStore?: AccountsStore;
};

function defaultAccount(): Account {
  return {
    id: DEFAULT_ACCOUNT_ID,
    name: "Default",
    defaults: BUILTIN_DEFAULTS,
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountsStoreWith(accounts: Account[]): AccountsStore {
  return new AccountsStore({
    listAccounts: () => Promise.resolve({ accounts }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
}

function field(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(
    'input[aria-label="Slideshow name"]',
  );
  if (element === null) throw new Error("The header has no name field.");
  return element;
}

/*
 * Types into a controlled input in one synchronous step. userEvent spends real
 * milliseconds per keystroke, which is more than the save debounce and would
 * make a test about the debounce prove nothing.
 */
function type_(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/*
 * The toast's own row. Radix also announces the message in a live region, so a
 * getByText for the words matches two nodes and fails strict mode whenever that
 * region is still mounted when the assertion runs.
 */
function toastText(): string {
  return [...document.querySelectorAll("ol > li")]
    .map((row) => row.textContent ?? "")
    .join(" | ");
}

/** The photo the stage is painting, which is what a person actually sees. */
function stageImageSource(): string | null {
  return (
    document.querySelector<HTMLImageElement>('[data-testid="stage"] img')?.src ?? null
  );
}

/*
 * Mounted on a real route, so leaving the editor is observable as a navigation
 * rather than as an internal flag. The dashboard stands in as a marker.
 */
function mount({ client, subscribe, library, accounts, accountsStore }: MountOptions) {
  return render(
    <MemoryRouter initialEntries={["/projects/project-1"]}>
      <ToastProvider>
        <AccountsProvider
          store={accountsStore ?? accountsStoreWith(accounts ?? [defaultAccount()])}
        >
          <Routes>
            <Route path="/" element={<p>Somewhere else</p>} />
            <Route
              path="/projects/:id"
              element={
                <Editor
                  projectId="project-1"
                  client={client}
                  library={library ?? emptyLibrary()}
                  subscribe={subscribe ?? (() => () => undefined)}
                />
              }
            />
          </Routes>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/*
 * Finding 4: `accountId` is undefined on the editor's very first render (the
 * project has not loaded yet), and useLibrary's effect used to fire
 * regardless — a full unscoped, stats-joined library fetch that was then
 * immediately discarded once the real, scoped accountId arrived a render
 * later. Deferring the project read lets this test observe the moment in
 * between: no library fetch should have started at all yet, and once the
 * project resolves, the only fetch that ever happens is the one scoped to
 * its real account.
 */
it("does not fetch the library unscoped while the slideshow itself is still loading", async () => {
  const project = fixtureProject({ slides: 1, accountId: "a1" });
  const client = fakeClient(project);
  let resolveProject!: () => void;
  const deferred = new Promise<void>((resolve) => {
    resolveProject = resolve;
  });
  client.getProject = async () => {
    await deferred;
    return { project: structuredClone(project) };
  };
  const calls: (string | undefined)[] = [];
  const library = new LibraryCache({
    listLibrary: ({ account } = {}) => {
      calls.push(account);
      return Promise.resolve({ items: [], total: 0 });
    },
  });

  const screen = await mount({
    client,
    library,
    accounts: [
      {
        id: "a1",
        name: "Brand A",
        defaults: BUILTIN_DEFAULTS,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  // Still loading: nothing has fetched the library yet.
  expect(calls).toEqual([]);

  resolveProject();
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();

  // Exactly one fetch, scoped to the slideshow's real account — never an
  // unscoped one first.
  expect(calls).toEqual(["a1"]);
  screen.unmount();
});

it("opens the slideshow and puts its name in the header", async () => {
  const client = fakeClient(fixtureProject({ slides: 2 }));
  const screen = await mount({ client });

  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Fixture");
  await expect
    .element(screen.getByRole("button", { name: "Open slide 2" }))
    .toBeVisible();
  await vi.waitFor(() => {
    expect(document.title).toBe("Fixture · Slide Studio");
  });
  screen.unmount();
});

it("shows the slideshow's owning account in the header", async () => {
  const client = fakeClient(fixtureProject({ accountId: "a1" }));
  const screen = await mount({
    client,
    accounts: [
      {
        id: "a1",
        name: "Main brand",
        defaults: BUILTIN_DEFAULTS,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  await expect.element(screen.getByText("Main brand")).toBeVisible();
  screen.unmount();
});

function failingAccountsStore(): AccountsStore {
  return new AccountsStore({
    listAccounts: () => Promise.reject(new Error("offline")),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
}

it("tells the reader once when the account catalogue fails to load, rather than staying silent", async () => {
  const client = fakeClient(fixtureProject({ accountId: "a1" }));
  const screen = await mount({ client, accountsStore: failingAccountsStore() });

  await vi.waitFor(() => {
    expect(toastText()).toContain("Couldn’t load this account’s style.");
  });
  screen.unmount();
});

/*
 * The fallback that lets a cold page add text at all (Editor.tsx's
 * `account?.defaults ?? BUILTIN_DEFAULTS`) must not be mistaken for a second,
 * silent failure path: a fetch that simply hasn't answered yet is not an
 * error, and must not toast one while a double-click still works against the
 * built-in look in the meantime.
 */
it("lets a double-click add text before a slow accounts fetch resolves, with no error while it's pending", async () => {
  const project = fixtureProject({ texts: 0, overlays: 0, accountId: "a1" });
  const client = fakeClient(project);
  let releaseAccounts = (_accounts: Account[]) => {
    /* replaced once the store asks for its accounts, below */
  };
  const pending = new AccountsStore({
    listAccounts: () =>
      new Promise((resolve) => {
        releaseAccounts = (accounts) => {
          resolve({ accounts });
        };
      }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
  const screen = await mount({ client, accountsStore: pending });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Fixture");

  const stage = await page.getByTestId("stage").element();
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );

  await vi.waitFor(() => {
    expect(live(client).slides[0]?.texts).toHaveLength(1);
  });
  expect(toastText()).not.toContain("Couldn’t load");

  releaseAccounts([
    {
      id: "a1",
      name: "Main brand",
      defaults: BUILTIN_DEFAULTS,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  await expect.element(screen.getByText("Main brand")).toBeVisible();
  expect(toastText()).not.toContain("Couldn’t load");
  screen.unmount();
});

it("renames the slideshow as it is typed", async () => {
  const client = fakeClient(fixtureProject());
  const screen = await mount({ client });
  const field = screen.getByRole("textbox", { name: "Slideshow name" });
  await expect.element(field).toHaveValue("Fixture");

  await userEvent.fill(field, "Morning routine");
  await expect.element(field).toHaveValue("Morning routine");
  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.name).toBe("Morning routine");
  });
  screen.unmount();
});

it("writes a pending edit when the editor is closed", async () => {
  // The clock is driven rather than waited on. A real 400ms wait would pass on
  // an editor that never disposed at all, because the debounce fires on its own
  // once enough time has gone by; under fake timers only the flush dispose
  // performs can land the write.
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject());
    const screen = await mount({ client });
    await vi.advanceTimersByTimeAsync(0);

    type_(field(), "Half typed");
    expect(client.saved).toHaveLength(0);

    screen.unmount();
    // Microtasks only. The save debounce is still 400ms away.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.saved.at(-1)?.name).toBe("Half typed");
  } finally {
    vi.useRealTimers();
  }
});

it("reloads when an agent changes the slideshow", async () => {
  const project = fixtureProject({ slides: 1 });
  const client = fakeClient(project);
  // A holder rather than a bare variable: TypeScript narrows one assigned only
  // inside a callback to never, and the pushes below stop typechecking.
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();
  expect(client.reads).toBe(1);

  const agentCopy = fixtureProject({ slides: 3 });
  agentCopy.version = 7;
  client.answer = agentCopy;
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 7 });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 3" }))
    .toBeVisible();
  expect(client.reads).toBe(2);
  screen.unmount();
});

it("ignores the broadcast its own save caused", async () => {
  const project = fixtureProject({ slides: 1, version: 4 });
  const client = fakeClient(project);
  // A holder rather than a bare variable: TypeScript narrows one assigned only
  // inside a callback to never, and the pushes below stop typechecking.
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();
  expect(client.reads).toBe(1);

  const before = library.reads();
  // app.js:1132. A version the editor already holds is its own echo, and
  // reloading on it pulls the document out from under the reader.
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 4 });
  bus.push?.({ type: "project.changed", projectId: "other", version: 99 });
  // Read on the spot rather than after a sleep. A reload calls the library
  // before its first await, so if either push had started one it would already
  // show here, and a wait would only make the same answer take longer.
  expect(library.reads()).toBe(before);
  expect(client.reads).toBe(1);
  screen.unmount();
});

it("adopts a status pushed by the server without writing it back", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1, version: 3 }));
    const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
    const screen = await mount({
      client,
      subscribe: (onEvent) => {
        bus.push = onEvent;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.handed.at(-1)?.status).toBe("draft");

    bus.push?.({ type: "project.status", projectId: "project-1", status: "published" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.handed.at(-1)?.status).toBe("published");

    /*
     * Three save debounces past the adoption, on a clock this test drives.
     * app.js:1122-1131 repaints and calls nothing: the server already holds this
     * label, so writing it back says nothing, and an adoption that schedules a
     * save rather than merely adopting would fire inside this window. That wrong
     * implementation is the one Task 13's reviewer planted.
     */
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    expect(client.statuses).toEqual([]);
    expect(client.saved).toEqual([]);
    expect(client.handed.at(-1)?.version).toBe(3);
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("leaves the editor when the slideshow is removed", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();

  bus.push?.({ type: "project.removed", projectId: "project-1" });
  // Holding a document the server no longer has means every save from here
  // fails, so the editor goes rather than sitting on it (app.js:1140-1142).
  await expect.element(screen.getByText("Somewhere else")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open slide 1" }).elements()).toHaveLength(0);
  await vi.waitFor(() => {
    expect(toastText()).toContain("This slideshow was removed.");
  });
  screen.unmount();
});

it("says nothing about a failed save once the slideshow is gone", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1 }));
    const attempts: string[] = [];
    client.save = (sent) => {
      attempts.push(sent.name);
      return Promise.reject(new Error("404"));
    };
    const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
    const screen = await mount({
      client,
      subscribe: (onEvent) => {
        bus.push = onEvent;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // An edit still inside the save debounce, then the removal. Closing the
    // editor flushes that edit at a slideshow the server has deleted.
    type_(field(), "Half typed");
    bus.push?.({ type: "project.removed", projectId: "project-1" });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);

    expect(document.body.textContent).toContain("Somewhere else");
    // The write really was attempted and really did fail, so this is not a test
    // that passes because nothing happened.
    expect(attempts).toEqual(["Half typed"]);
    expect(toastText()).toContain("This slideshow was removed.");
    expect(toastText()).not.toContain("Couldn’t save this slideshow.");
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("refreshes the library before it reads the reloaded slideshow", async () => {
  const order: string[] = [];
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const read = client.getProject;
  client.getProject = (id) => {
    order.push("project");
    return read(id);
  };
  const library = new LibraryCache({
    listLibrary: () => {
      order.push("library");
      return Promise.resolve({ items: [], total: 0 });
    },
  });
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();
  order.length = 0;

  const agentCopy = fixtureProject({ slides: 2 });
  agentCopy.version = 9;
  client.answer = agentCopy;
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 2" }))
    .toBeVisible();

  // app.js:1109-1110. The other order leaves a slide the agent added without a
  // background until a second request lands.
  expect(order).toEqual(["library", "project"]);
  await vi.waitFor(() => {
    expect(toastText()).toContain("An agent changed this slideshow, so it reloaded.");
  });
  screen.unmount();
});

it("does not reload over a write that is still in flight", async () => {
  const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
  // A save that never answers, so the editor sits in "saving" for the whole test.
  const inFlight: (() => void)[] = [];
  client.save = (sent) => {
    client.saved.push(structuredClone(sent));
    return new Promise(() => {
      inFlight.push(() => undefined);
    });
  };
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();
  expect(client.reads).toBe(1);

  await userEvent.fill(
    screen.getByRole("textbox", { name: "Slideshow name" }),
    "Being typed",
  );
  await vi.waitFor(() => {
    expect(client.saved).toHaveLength(1);
  });

  /*
   * app.js:1134's !state.saveInFlight. Reloading now would replace the document
   * under a PUT that is still on the wire, so the write that lands a moment
   * later would carry a version the editor no longer holds. The 409 that write
   * takes reloads through the same path anyway, which is why skipping here
   * loses nothing.
   */
  client.answer = fixtureProject({ slides: 3 });
  const beforeReload = library.reads();
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 12 });
  // As above: the reload's first act is synchronous, so no wait is needed to
  // learn that it never began.
  expect(library.reads()).toBe(beforeReload);
  expect(client.reads).toBe(1);
  expect(screen.getByRole("button", { name: "Open slide 3" }).elements()).toHaveLength(0);
  screen.unmount();
});

it("leaves photo mode when another slide is chosen", async () => {
  const client = fakeClient(fixtureProject({ slides: 2 }));
  const screen = await mount({ client });
  const adjust = screen.getByRole("button", { name: "Adjust photo" });
  await expect.element(adjust).toBeVisible();

  await userEvent.click(adjust);
  await expect.element(adjust).toHaveAttribute("aria-pressed", "true");

  // app.js:2179. Placing one photo and then looking at another slide are two
  // different intents, and staying in photo mode makes the layers unclickable
  // on a slide the reader never asked to place.
  await userEvent.click(screen.getByRole("button", { name: "Open slide 2" }));
  await expect.element(adjust).toHaveAttribute("aria-pressed", "false");
  screen.unmount();
});

/**
 * Runs a test at a viewport width, then puts the old one back. Vitest resizes
 * the iframe the whole file renders into, so leaving it narrow would reshape
 * every test that follows.
 */
async function atWidth(width: number, run: () => Promise<void>): Promise<void> {
  const was = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, was.height);
  try {
    await run();
  } finally {
    await page.viewport(was.width, was.height);
  }
}

it("still switches slides with the rail at its narrowest", async () => {
  await atWidth(760, async () => {
    const client = fakeClient(fixtureProject({ slides: 2 }));
    const screen = await mount({ client });
    const adjust = screen.getByRole("button", { name: "Adjust photo" });
    await expect.element(adjust).toBeVisible();

    // styles.css:3259-3262. The rail is 68px here, and every label inside it is
    // gone, which is the state that turns a mis-sized control into a control
    // nobody can hit.
    const shell = document.querySelector("main");
    if (shell === null) throw new Error("The editor shell did not render.");
    expect(getComputedStyle(shell).gridTemplateColumns.split(" ")[0]).toBe("68px");

    await userEvent.click(adjust);
    await expect.element(adjust).toHaveAttribute("aria-pressed", "true");

    // The same journey as on a wide screen, through a rail a third the width.
    await userEvent.click(screen.getByRole("button", { name: "Open slide 2" }));
    await expect.element(adjust).toHaveAttribute("aria-pressed", "false");
    screen.unmount();
  });
});

it("leaves photo mode when the slide being placed is removed", async () => {
  const client = fakeClient(fixtureProject({ slides: 2 }));
  const screen = await mount({ client });
  const adjust = screen.getByRole("button", { name: "Adjust photo" });
  await expect.element(adjust).toBeVisible();
  await userEvent.click(adjust);
  await expect.element(adjust).toHaveAttribute("aria-pressed", "true");

  // app.js:3056 clears the flag along with the slide, so the mode cannot
  // outlive the photo it was placing.
  await userEvent.click(screen.getByRole("button", { name: "Actions for slide 1" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove slide" }));
  await expect.element(adjust).toHaveAttribute("aria-pressed", "false");
  screen.unmount();
});

it("abandons a reload whose editor closed under it", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const held: (() => void)[] = [];
  const library = new LibraryCache({
    listLibrary: () =>
      new Promise((resolve) => {
        held.push(() => {
          resolve({ items: [], total: 0 });
        });
      }),
  });
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();

  client.answer = fixtureProject({ slides: 4 });
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  // The reload is parked on its first await. Closing the editor here is the
  // ordinary case: a reader navigating away the moment an agent writes.
  const parked = library.refresh();
  screen.unmount();
  for (const release of held) release();

  /*
   * Awaiting the very promise the reload is parked on, rather than a sleep.
   * The reload registered its continuation before this line did, so by the time
   * this resolves the reload has already had its turn and would have issued the
   * read if nothing had called it off.
   */
  await parked;
  expect(client.reads).toBe(1);
  expect(toastText()).not.toContain("An agent changed this slideshow");
});

type Blocked = {
  client: Fake;
  library: CountedLibrary;
  bus: { push: ((event: ServerEvent) => void) | null };
  settle: (project: Project) => void;
  fail: (error: unknown) => void;
  screen: Awaited<ReturnType<typeof mount>>;
};

/**
 * An editor with a real write stuck on the wire: the name is typed, the save
 * fires, and its promise is held open so the editor sits in "saving" for as
 * long as the test wants it to.
 */
async function withSaveInFlight(version: number): Promise<Blocked> {
  const client = fakeClient(fixtureProject({ slides: 1, version }));
  const held: {
    resolve: (project: Project) => void;
    reject: (error: unknown) => void;
  }[] = [];
  client.save = (sent) => {
    client.saved.push(structuredClone(sent));
    return new Promise<Project>((resolve, reject) => {
      held.push({ resolve, reject });
    });
  };
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();

  await userEvent.fill(
    screen.getByRole("textbox", { name: "Slideshow name" }),
    "Being typed",
  );
  await vi.waitFor(() => {
    expect(client.saved).toHaveLength(1);
  });

  return {
    client,
    library,
    bus,
    screen,
    settle: (project) => {
      held[0]?.resolve(project);
    },
    fail: (error) => {
      held[0]?.reject(error);
    },
  };
}

it("reloads once the save that blocked it has landed", async () => {
  const { client, library, bus, screen, settle } = await withSaveInFlight(2);
  const before = library.reads();

  // The agent writes while the person's own PUT is still on the wire.
  const agentCopy = fixtureProject({ slides: 3 });
  agentCopy.version = 9;
  client.answer = agentCopy;
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  // Nothing yet, which is the guard doing its job.
  expect(library.reads()).toBe(before);
  expect(client.reads).toBe(1);

  /*
   * The PUT returns 200. Before this fix the event was gone: the person sat on
   * a stale document with a healthy stream and no toast, indefinitely, which is
   * worse than the clobber the guard prevents because a clobber is visible.
   */
  settle({ ...structuredClone(client.saved[0]!), version: 3 });

  await expect
    .element(screen.getByRole("button", { name: "Open slide 3" }))
    .toBeVisible();
  expect(client.reads).toBe(2);
  await vi.waitFor(() => {
    expect(toastText()).toContain("An agent changed this slideshow, so it reloaded.");
  });
  screen.unmount();
});

it("reloads once for several events that arrived during one save", async () => {
  const { client, bus, screen, settle } = await withSaveInFlight(2);

  const agentCopy = fixtureProject({ slides: 4 });
  agentCopy.version = 12;
  client.answer = agentCopy;

  /*
   * Three writes land while the one save is out, and the stream does not
   * promise to deliver them in order. What is owed is how far ahead the server
   * is, which is the highest version named and not the last one named: keeping
   * the last would leave the editor believing the server sits at 9, decide
   * that its own save had caught up, and stay stale for good.
   */
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 12 });
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 11 });
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  expect(client.reads).toBe(1);

  // The save lands at 10, past two of those three frames.
  settle({ ...structuredClone(client.saved[0]!), version: 10 });
  await expect
    .element(screen.getByRole("button", { name: "Open slide 4" }))
    .toBeVisible();
  // One read, for three events that describe one server.
  expect(client.reads).toBe(2);
  screen.unmount();
});

it("drops the deferred reload when its own save is what advanced the version", async () => {
  const { client, library, bus, screen, settle } = await withSaveInFlight(2);
  const before = library.reads();

  /*
   * The server broadcasts the person's own write as well, and that frame often
   * beats the reply to it. Deferring is right; replaying blindly afterwards
   * would read the slideshow back for a change the editor had itself made.
   */
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 3 });
  settle({ ...structuredClone(client.saved[0]!), version: 3 });

  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
  expect(client.reads).toBe(1);
  expect(library.reads()).toBe(before);
  screen.unmount();
});

it("does not reload over an edit whose save failed", async () => {
  const { client, library, bus, screen, fail } = await withSaveInFlight(2);
  const before = library.reads();

  client.answer = fixtureProject({ slides: 5 });
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  // The write never reached the server, so the edit it carried lives only in
  // this editor. Reloading over it would throw away work the reader can still
  // see, which is the very thing the guard exists to prevent.
  fail(new Error("offline"));

  await vi.waitFor(() => {
    expect(toastText()).toContain("Couldn’t save this slideshow.");
  });
  expect(client.reads).toBe(1);
  expect(library.reads()).toBe(before);
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Being typed");
  expect(screen.getByRole("button", { name: "Open slide 5" }).elements()).toHaveLength(0);
  screen.unmount();
});

/** The header's save state, which outlives the toast that announced it. */
function indicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-save-state]");
}

/**
 * The upload inside the open background picker. Awaiting the dialog first is
 * the point: the input does not exist until it is up, so a query racing the
 * render would find nothing and prove nothing.
 */
async function openSlidePicker(): Promise<HTMLInputElement> {
  await userEvent.click(page.getByRole("button", { name: "New slide" }));
  await expect.element(page.getByRole("dialog", { name: "New slide" })).toBeVisible();
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[type="file"]',
  );
  if (input === null) throw new Error("The picker has no file input.");
  return input;
}

function imageFile(name: string): File {
  return new File(["png"], name, { type: "image/png" });
}

/*
 * The button was rendered `disabled={onAddSlide === undefined}` and Editor
 * never passed the handler, so the first control a person reaches for was dead
 * from the first day. Every rail test passed its own props, so none of them
 * ever saw what Editor actually passes: the same seam that hid the background
 * cache bug earlier in this task.
 */
it("adds a slide from the New slide button", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const screen = await mount({ client });
  const button = screen.getByRole("button", { name: "New slide" });
  await expect.element(button).toBeVisible();
  // Enabled, which is the whole finding: it rendered, it just never enabled.
  await expect.element(button).not.toHaveAttribute("aria-disabled", "true");
  expect(button.element()).not.toHaveProperty("disabled", true);

  /*
   * The press has to be what opens the picker. Feeding the input without
   * asserting that leaves the button's own handler unexercised, which is how
   * the first version of this test passed against an Editor that had gone back
   * to passing no handler at all.
   */
  const input = await openSlidePicker();
  // Several at once, which is what "each image becomes a slide" needs.
  await expect.element(input).toHaveAttribute("multiple");
  await userEvent.upload(input, [imageFile("beach.png"), imageFile("dunes.png")]);

  await expect
    .element(screen.getByRole("button", { name: "Open slide 3" }))
    .toBeVisible();
  const slides = live(client).slides;
  expect(slides).toHaveLength(3);
  // Each image became a slide, named after its file and backed by its upload.
  expect(slides[1]?.name).toBe("beach");
  expect(slides[2]?.name).toBe("dunes");
  expect(slides[1]?.backgroundItemId).toBe("item-beach.png");
  expect(uploads.seen).toEqual(["beach.png", "dunes.png"]);
  // Drawn rather than merely recorded. The stage resolves a background through
  // the library cache without awaiting, so an upload that never reached the
  // cache leaves the slide it was added for painting nothing at all.
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("/media/item-beach.png.png");
  });
  // The slide they asked for is the one they are looking at.
  await expect
    .element(screen.getByRole("button", { name: "Open slide 2" }))
    .toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => {
    expect(toastText()).toContain("2 slides added");
  });
  screen.unmount();
});

it("adds a slide from a background already in the library", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const cache = new LibraryCache({
    listLibrary: () =>
      Promise.resolve({ items: [libraryItemFor("item-curated")], total: 1 }),
  });
  const screen = await mount({ client, library: cache });
  await expect.element(screen.getByRole("button", { name: "New slide" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "New slide" }));
  await userEvent.click(page.getByRole("button", { name: "item-curated" }));

  // The whole point of the feature: a curated background becomes a slide with
  // nothing uploaded at all.
  await expect
    .element(screen.getByRole("button", { name: "Open slide 2" }))
    .toBeVisible();
  const slides = live(client).slides;
  expect(slides).toHaveLength(2);
  expect(slides[1]?.backgroundItemId).toBe("item-curated");
  expect(uploads.seen).toEqual([]);
  // And the slide is drawn, rather than pointing at something nothing resolves.
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("/media/item-curated.png");
  });
  // Written through the store like any other edit, so the save layer sees it as
  // owed work. A slide added around that route would never reach the server.
  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.slides).toHaveLength(2);
  });
  screen.unmount();
});

it("replaces a slide's background from the library", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const cache = new LibraryCache({
    listLibrary: () =>
      Promise.resolve({
        items: [libraryItemFor("item-1"), libraryItemFor("item-curated")],
        total: 2,
      }),
  });
  const screen = await mount({ client, library: cache });
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("/media/item-1.png");
  });

  await userEvent.click(screen.getByRole("button", { name: "Actions for slide 1" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Change" }));
  await userEvent.click(page.getByRole("button", { name: "item-curated" }));

  // What the person is looking at changed, which is the only proof that counts.
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("/media/item-curated.png");
  });
  expect(live(client).slides[0]?.backgroundItemId).toBe("item-curated");
  // From the library, so nothing was uploaded to get there.
  expect(uploads.seen).toEqual([]);
  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.slides[0]?.backgroundItemId).toBe("item-curated");
  });
  screen.unmount();
});

it("says so when the chosen files hold no image", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  const screen = await mount({ client });
  await expect.element(screen.getByRole("button", { name: "New slide" })).toBeVisible();

  const input = await openSlidePicker();
  await userEvent.upload(input, new File(["notes"], "notes.txt", { type: "text/plain" }));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Choose an image file.");
  expect(live(client).slides).toHaveLength(1);
  screen.unmount();
});

it("keeps the slideshow as it was when every upload fails", async () => {
  const client = fakeClient(fixtureProject({ slides: 1 }));
  uploads.run = () => Promise.reject(new Error("no room"));
  const screen = await mount({ client });
  await expect.element(screen.getByRole("button", { name: "New slide" })).toBeVisible();

  const input = await openSlidePicker();
  await userEvent.upload(input, imageFile("beach.png"));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That image couldn’t be uploaded.");
  expect(live(client).slides).toHaveLength(1);
  /*
   * And the picker is still up, so the person can pick something else. The rest
   * of the page is behind the modal and out of the accessibility tree while it
   * is, which is why nothing outside the dialog is asked for here.
   */
  await expect.element(page.getByRole("dialog", { name: "New slide" })).toBeVisible();
  screen.unmount();
});

it("keeps the edit when an external write lands inside the debounce window", async () => {
  const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
  const agentCopy = fixtureProject({ slides: 3 });
  agentCopy.version = 9;
  /*
   * A server that behaves like one: it accepts the person's PUT, so from then
   * on it holds their name alongside the agent's slides, and anything read back
   * carries both. Its answer is the one-slide project until the agent writes,
   * so a slide the agent added is proof that a reload happened rather than
   * something the editor opened with.
   */
  client.save = (sent) => {
    client.saved.push(structuredClone(sent));
    const merged = {
      ...structuredClone(agentCopy),
      name: sent.name,
      version: sent.version + 1,
    };
    client.answer = merged;
    return Promise.resolve(merged);
  };
  const library = countingLibrary();
  const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const screen = await mount({
    client,
    library: library.cache,
    subscribe: (onEvent) => {
      bus.push = onEvent;
      return () => undefined;
    },
  });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();
  // One slide, and that is what the editor is holding.
  expect(screen.getByRole("button", { name: "Open slide 3" }).elements()).toHaveLength(0);

  /*
   * Typed, and then an agent writes before the four hundred millisecond
   * debounce has fired. SaveState read "idle" for that whole window until it
   * could say an edit was owed, so this is where the reload used to land on a
   * change the server had never been told about.
   */
  type_(field(), "Being typed");
  client.answer = agentCopy;
  bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
  expect(client.reads).toBe(1);

  // The debounce fires, the write lands, and the deferred reload follows it.
  await expect
    .element(screen.getByRole("button", { name: "Open slide 3" }))
    .toBeVisible();
  expect(client.reads).toBe(2);
  // Which is the point of all of it: the reload happened, the agent's change is
  // here, and the person's edit is not gone.
  expect(client.saved.at(-1)?.name).toBe("Being typed");
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Being typed");
  screen.unmount();
});

it("raises the unload prompt only while an edit is unsent", async () => {
  const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
  const screen = await mount({ client });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();

  const ask = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  // Nothing owed, so leaving is nobody's business but the reader's.
  expect(ask()).toBe(false);

  type_(field(), "Half typed");
  // Owed and unsent. Browsers show their own wording; the only decision here is
  // whether to raise the prompt at all.
  expect(ask()).toBe(true);

  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.name).toBe("Half typed");
  });
  await vi.waitFor(() => {
    expect(ask()).toBe(false);
  });
  screen.unmount();
});

it("keeps asking on unload while a failed save goes unretried", async () => {
  const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
  client.save = (sent) => {
    client.saved.push(structuredClone(sent));
    return Promise.reject(new Error("offline"));
  };
  const screen = await mount({ client });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();

  type_(field(), "Half typed");
  await vi.waitFor(() => {
    expect(client.saved).toHaveLength(1);
  });
  await vi.waitFor(() => {
    expect(toastText()).toContain("Couldn’t save this slideshow.");
  });

  // The write failed and nothing retries it, so the edit is still only here.
  // A state that said "idle" after a failure would have let this tab close on it.
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  screen.unmount();
});

it("says so rather than waiting for ever when the blocking write never lands", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
    // A write that hangs on the wire and never answers either way.
    client.save = (sent) => {
      client.saved.push(structuredClone(sent));
      return new Promise<Project>(() => undefined);
    };
    const library = countingLibrary();
    const bus: { push: ((event: ServerEvent) => void) | null } = { push: null };
    const screen = await mount({
      client,
      library: library.cache,
      subscribe: (onEvent) => {
        bus.push = onEvent;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = library.reads();

    type_(field(), "Being typed");
    bus.push?.({ type: "project.changed", projectId: "project-1", version: 9 });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(client.saved).toHaveLength(1);

    /*
     * Past the bound. The editor will not reload over unsent work, so the one
     * thing left is to say the copy is behind: waiting in silence for a
     * transition that is never coming is the bug this whole change is about,
     * with a longer fuse.
     */
    await vi.advanceTimersByTimeAsync(STALE_NOTICE_MS + 1);
    // React schedules its renders on a MessageChannel, which fake timers do not
    // drive; each of these yields a macrotask so the toast it queued can paint.
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(0);
    expect(library.reads()).toBe(before);
    expect(client.reads).toBe(1);
    expect(toastText()).toContain("Your copy is behind until your edit saves.");
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("saves an edit unattended once the server comes back", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
    // The server is down. Every write is refused until it is not.
    let up = false;
    client.save = (sent) => {
      if (!up) return Promise.reject(new Error("ECONNREFUSED"));
      client.saved.push(structuredClone(sent));
      return Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 });
    };
    const screen = await mount({ client });
    await vi.advanceTimersByTimeAsync(0);

    type_(field(), "Written while it was down");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(client.saved).toHaveLength(0);
    // The indicator says so, and keeps saying so after the toast has gone.
    expect(indicator()?.textContent).toBe("Not saved");

    /*
     * The server comes back, and nobody touches the app. app.js would have left
     * this edit stranded for ever: Saver.run only looped when another edit
     * queued a follow-up, so a failure nothing followed simply sat there.
     */
    up = true;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);

    expect(client.saved.at(-1)?.name).toBe("Written while it was down");
    await vi.advanceTimersByTimeAsync(0);
    expect(indicator()?.textContent).toBe("Saved");
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("stops retrying rather than hammering a server that stays down", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
    let attempts = 0;
    client.save = () => {
      attempts += 1;
      return Promise.reject(new Error("ECONNREFUSED"));
    };
    const screen = await mount({ client });
    await vi.advanceTimersByTimeAsync(0);

    type_(field(), "Written while it was down");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    // Hours of a server that never comes back.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * RETRY_LIMIT * 4);

    // The first write plus its allowance of retries, and then it stops. A loop
    // that never gave up would be far past this by now.
    expect(attempts).toBe(RETRY_LIMIT + 1);
    // And it still says the work is unsaved, which is the honest thing to say.
    expect(indicator()?.textContent).toBe("Not saved");

    /*
     * A new edit is a fresh start, so the person is never stuck for good. The
     * new write goes out either way, so what proves the allowance was reset is
     * what happens after that one fails too: with a reset it keeps trying, and
     * without one it gives up on the spot.
     */
    type_(field(), "Touched again");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(attempts).toBe(RETRY_LIMIT + 2);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * RETRY_LIMIT * 4);
    expect(attempts).toBe(RETRY_LIMIT * 2 + 2);
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("says only once that a save failed, however many times it retries", async () => {
  vi.useFakeTimers();
  try {
    const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
    client.save = () => Promise.reject(new Error("ECONNREFUSED"));
    const screen = await mount({ client });
    await vi.advanceTimersByTimeAsync(0);

    type_(field(), "Written while it was down");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(0);
    // The first failure is said out loud, once.
    expect(toastText()).toContain("Couldn’t save this slideshow.");

    /*
     * Five seconds covers the first three retries. A message per attempt would
     * keep putting the toast back up and its timer with it, so a toast still on
     * screen here is the twenty-of-the-same-message case; an empty screen is
     * the indicator carrying it instead.
     */
    await vi.advanceTimersByTimeAsync(5_000);
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(0);
    expect(toastText()).not.toContain("Couldn’t save this slideshow.");
    // And the state is still on screen, which is the point of having it.
    expect(indicator()?.textContent).toBe("Not saved");
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("shows the three states a slideshow can be in", async () => {
  const client = fakeClient(fixtureProject({ slides: 1, version: 2 }));
  const held: ((project: Project) => void)[] = [];
  client.save = (sent) => {
    client.saved.push(structuredClone(sent));
    return new Promise<Project>((resolve) => {
      held.push(resolve);
    });
  };
  const screen = await mount({ client });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();

  // Nothing owed.
  expect(indicator()?.textContent).toBe("Saved");

  // Edited, and the server has not been told.
  type_(field(), "Half typed");
  expect(indicator()?.textContent).toBe("Not saved");

  // On the wire.
  await vi.waitFor(() => {
    expect(indicator()?.textContent).toBe("Saving…");
  });

  held[0]?.({ ...structuredClone(client.saved[0]!), version: 3 });
  await vi.waitFor(() => {
    expect(indicator()?.textContent).toBe("Saved");
  });
  screen.unmount();
});

it("says so when the slideshow cannot be opened", async () => {
  const client = fakeClient(fixtureProject());
  client.getProject = () => Promise.reject(new Error("gone"));
  const screen = await mount({ client });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn’t open this slideshow.");
  screen.unmount();
});

it("tells the reader when a save fails", async () => {
  const client = fakeClient(fixtureProject());
  client.save = () => Promise.reject(new Error("offline"));
  const screen = await mount({ client });
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Fixture");

  await userEvent.fill(screen.getByRole("textbox", { name: "Slideshow name" }), "Nope");
  await vi.waitFor(() => {
    expect(toastText()).toContain("Couldn’t save this slideshow.");
  });
  screen.unmount();
});

/*
 * The caption, through the editor a person actually opens: the header button,
 * the panel behind it, and the two copy buttons that are the reason both fields
 * exist. Nothing here mounts CaptionPanel on its own, because a panel that is
 * unreachable from the header would still pass that.
 */

function captioned(description: string, hashtags: string): Project {
  return { ...fixtureProject(), description, hashtags };
}

/** What the page put on the clipboard, without touching the real one. */
function captureClipboard(): { copied: string[]; stop: () => void } {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (value: string) => {
        copied.push(value);
        return Promise.resolve();
      },
    },
  });
  return {
    copied,
    stop: () => {
      Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}

it("keeps the caption behind its header button until it is asked for", async () => {
  const client = fakeClient(captioned("Five things to know first", "#travel"));
  const screen = await mount({ client });

  // The positive signal: the button that opens the panel is on the header, so
  // the header rendered and the fields below are absent by choice.
  await expect.element(screen.getByRole("button", { name: "Caption" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Description" }).elements()).toHaveLength(0);

  await userEvent.click(screen.getByRole("button", { name: "Caption" }));
  await expect
    .element(screen.getByRole("textbox", { name: "Description" }))
    .toHaveValue("Five things to know first");
  await expect
    .element(screen.getByRole("textbox", { name: "Hashtags" }))
    .toHaveValue("#travel");
  screen.unmount();
});

it("copies the description and the hashtags an agent drafted", async () => {
  const clipboard = captureClipboard();
  try {
    const client = fakeClient(captioned("Five things to know first", "#travel #summer"));
    const screen = await mount({ client });
    await userEvent.click(screen.getByRole("button", { name: "Caption" }));

    await userEvent.click(screen.getByRole("button", { name: "Copy description" }));
    await vi.waitFor(() => {
      expect(clipboard.copied).toEqual(["Five things to know first"]);
    });
    await vi.waitFor(() => {
      expect(toastText()).toContain("Description copied");
    });

    await userEvent.click(screen.getByRole("button", { name: "Copy hashtags" }));
    await vi.waitFor(() => {
      expect(clipboard.copied.at(-1)).toBe("#travel #summer");
    });
    screen.unmount();
  } finally {
    clipboard.stop();
  }
});

it("says so when the browser refuses the clipboard, rather than claiming a copy", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  try {
    const client = fakeClient(captioned("Five things to know first", "#travel"));
    const screen = await mount({ client });
    await userEvent.click(screen.getByRole("button", { name: "Caption" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy description" }));

    await vi.waitFor(() => {
      expect(toastText()).toContain("Couldn’t copy the description.");
    });
    expect(toastText()).not.toContain("Description copied");
    screen.unmount();
  } finally {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("saves a caption the reader types, on the same path as every other edit", async () => {
  const client = fakeClient(fixtureProject());
  const screen = await mount({ client });
  await userEvent.click(screen.getByRole("button", { name: "Caption" }));

  await userEvent.fill(
    screen.getByRole("textbox", { name: "Description" }),
    "Booking a summer trip?",
  );
  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.description).toBe("Booking a summer trip?");
  });
  // The document went with it rather than being replaced by a caption-only
  // write, which is what riding the version guarded PUT means.
  expect(client.saved.at(-1)?.slides).toHaveLength(1);
  screen.unmount();
});

it("tidies the hashtags when the reader leaves the field", async () => {
  const client = fakeClient(fixtureProject());
  const screen = await mount({ client });
  await userEvent.click(screen.getByRole("button", { name: "Caption" }));

  const field = screen.getByRole("textbox", { name: "Hashtags" });
  await userEvent.fill(field, "travel, Travel summer");
  // Untouched while the reader is still in the field: rewriting a tag halfway
  // through its first letter would fight the typist.
  await expect.element(field).toHaveValue("travel, Travel summer");

  await userEvent.tab();

  await expect.element(field).toHaveValue("#travel #summer");
  await vi.waitFor(() => {
    expect(client.saved.at(-1)?.hashtags).toBe("#travel #summer");
  });
  screen.unmount();
});
