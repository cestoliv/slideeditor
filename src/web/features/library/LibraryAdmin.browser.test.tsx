import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { userEvent } from "vitest/browser";
import type { LibraryItem, LibraryUse } from "@shared/schema/index.js";
// The page paints from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
import { ApiError } from "../../app/api.js";
import { ProjectsProvider, ProjectsStore } from "../../app/projects.js";
import type { ProjectsClient, Subscribe } from "../../app/projects.js";
import type { LibraryCreateInput, LibraryPatch, LibraryQuery } from "../../app/api.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { LibraryAdmin } from "./LibraryAdmin.js";
import type { LibraryAdminClient } from "./LibraryAdmin.js";

const DAY = 86400000;

let counter = 0;

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  counter += 1;
  const id = `i${String(counter)}`;
  return {
    id,
    kind: "background",
    name: "Sunset",
    description: "",
    usage: "",
    tags: [],
    mediaId: id,
    ext: "png",
    // A data URL, so no request leaves the page for a thumbnail.
    url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
    ...overrides,
  };
}

/** cleanTags, src/server/services/library.ts:329-333. */
function cleanTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

type Fake = LibraryAdminClient & {
  /** Stands in for Date.now(), so a stamped updatedAt is deterministic. */
  clock: number;
  items: LibraryItem[];
  listed: LibraryQuery[];
  created: LibraryCreateInput[];
  patched: { id: string; patch: LibraryPatch }[];
  deleted: { id: string; force: boolean }[];
  /** Slideshows the next delete of this id is refused for, as a 409 would name. */
  usedBy: Map<string, LibraryUse[]>;
  listLibrary: (query?: LibraryQuery) => Promise<{ items: LibraryItem[]; total: number }>;
};

/**
 * The server, minus the server. Delete answers 409 with the named slideshows
 * unless the caller forces it, which is what src/server/routes/library.ts:57
 * and src/server/services/library.ts:258-263 do between them.
 */
function fakeClient(items: LibraryItem[]): Fake {
  const fake: Fake = {
    clock: 1000,
    items,
    listed: [],
    created: [],
    patched: [],
    deleted: [],
    usedBy: new Map(),
    listLibrary: (query: LibraryQuery = {}) => {
      fake.listed.push(query);
      return Promise.resolve({ items: [...fake.items], total: fake.items.length });
    },
    createLibraryItem: (input: LibraryCreateInput) => {
      fake.created.push(input);
      const made = item({
        kind: input.kind,
        name: input.name,
        updatedAt: 1000 + fake.created.length,
      });
      fake.items.push(made);
      return Promise.resolve({ item: made });
    },
    updateLibraryItem: (id: string, patch: LibraryPatch) => {
      fake.patched.push({ id, patch });
      const index = fake.items.findIndex((entry) => entry.id === id);
      const { tags, ...rest } = patch;
      const saved: LibraryItem = {
        ...(fake.items[index] as LibraryItem),
        ...rest,
        // cleanTags (src/server/services/library.ts:329-333) trims, lowercases
        // and drops duplicates, so what a person types is rarely what comes back.
        ...(tags === undefined ? {} : { tags: cleanTags(tags) }),
        // The server stamps updated_at on every PATCH
        // (src/server/services/library.ts:236). Without this the fake modelled a
        // server whose edits are invisible to the default sort, which is the one
        // thing that made the reordering bug unreachable from a test.
        updatedAt: (fake.clock += 1),
      };
      fake.items[index] = saved;
      return Promise.resolve({ item: saved });
    },
    deleteLibraryItem: (id: string, options: { force?: boolean } = {}) => {
      const force = options.force ?? false;
      fake.deleted.push({ id, force });
      const blocking = fake.usedBy.get(id) ?? [];
      if (blocking.length > 0 && !force) {
        return Promise.reject(
          new ApiError(409, "That image is used by a slideshow.", { usedBy: blocking }),
        );
      }
      fake.items = fake.items.filter((entry) => entry.id !== id);
      return Promise.resolve({ removed: id, brokeSlideshows: blocking });
    },
  };
  return fake;
}

const noStream: Subscribe = () => () => {};

function EditorProbe() {
  const { id } = useParams();
  return <p>Editor for {id}</p>;
}

/** The header's New slideshow button needs the store, and nothing else here does. */
function fakeProjects(): ProjectsClient & { created: number } {
  const fake = {
    created: 0,
    listProjects: () => Promise.resolve({ projects: [] }),
    createProject: () => {
      fake.created += 1;
      return Promise.resolve({
        project: {
          id: "p-new",
          name: "New Project",
          version: 1,
          status: "draft" as const,
          description: "",
          hashtags: "",
          createdAt: 1,
          updatedAt: 1,
          ratio: { w: 9, h: 16 },
          slides: [],
        },
      });
    },
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  };
  return fake;
}

async function mount(
  client: Fake,
  kind: "background" | "asset" = "background",
  projects: ProjectsClient = fakeProjects(),
) {
  const cache = new LibraryCache(client);
  return render(
    <MemoryRouter
      initialEntries={[kind === "asset" ? "/library/assets" : "/library/backgrounds"]}
    >
      <ToastProvider>
        <ProjectsProvider store={new ProjectsStore(projects)} subscribe={noStream}>
          <Routes>
            {/* The wiring app/router.tsx gives the page: the kind comes from the URL. */}
            <Route
              path="/library/backgrounds"
              element={<LibraryAdmin kind="background" cache={cache} client={client} />}
            />
            <Route
              path="/library/assets"
              element={<LibraryAdmin kind="asset" cache={cache} client={client} />}
            />
            {/* Where the header's New slideshow button lands. */}
            <Route path="/projects/:id" element={<EditorProbe />} />
          </Routes>
        </ProjectsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The picker the upload button clicks. It is display:none, so nothing sees it. */
function picker(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("The page has no file picker.");
  return input;
}

/**
 * Choosing files, the way the browser reports it. Playwright's own upload needs
 * a visible control, and this picker is hidden behind the upload button.
 */
function choose(files: File[]): void {
  const input = picker();
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function png(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** The delete buttons name their card, so their order is the grid's order. */
function gridOrder(): string[] {
  return [...document.querySelectorAll("[aria-label^='Delete ']")].map((element) =>
    (element.getAttribute("aria-label") ?? "").replace("Delete ", ""),
  );
}

it("uploads a file with a name, a description, and a usage note", async () => {
  const client = fakeClient([]);
  const screen = await mount(client);
  await expect
    .element(screen.getByText("No backgrounds yet", { exact: false }))
    .toBeVisible();

  choose([png("golden-hour.png")]);

  // The picker names the item, which is all a file can say about itself.
  const name = screen.getByRole("textbox", { name: "Name" });
  await expect.element(name).toHaveValue("golden-hour");
  expect(client.created).toHaveLength(1);
  expect(client.created[0]?.kind).toBe("background");
  expect(client.created[0]?.data.startsWith("data:image/png;base64,")).toBe(true);

  // The two fields an agent actually reads are typed in afterwards, on the card.
  await screen
    .getByRole("textbox", { name: "Description · what it shows" })
    .fill("A wide sunset");
  await screen
    .getByRole("textbox", { name: "Usage · when to use it" })
    .fill("Open a travel post");
  await name.click();

  await expect.poll(() => client.patched).toHaveLength(2);
  expect(client.patched.map((call) => call.patch)).toEqual([
    { description: "A wide sunset" },
    { usage: "Open a travel post" },
  ]);
});

it("uploads several files at once and counts them", async () => {
  const client = fakeClient([]);
  const screen = await mount(client);
  choose([png("one.png"), png("two.png")]);
  await expect
    .element(screen.getByRole("textbox", { name: "Name" }).first())
    .toBeVisible();
  await expect
    .poll(() => client.created.map((call) => call.name))
    .toEqual(["one", "two"]);
  await expect.element(screen.getByText("2 images uploaded")).toBeVisible();
});

it("ignores a chosen file that is not an image", async () => {
  const client = fakeClient([]);
  const screen = await mount(client);

  // The image goes in the same batch on purpose. Asserting the absence of an
  // upload proves nothing on its own, because an upload that has merely not
  // happened yet looks exactly like one that was refused. The count in the
  // toast is the signal: it can only be written once the whole batch is done,
  // and it says two rather than one the moment the filter stops filtering.
  choose([new File(["notes"], "notes.txt", { type: "text/plain" }), png("photo.png")]);

  await expect.element(screen.getByText("1 image uploaded")).toBeVisible();
  expect(client.created.map((call) => call.name)).toEqual(["photo"]);
});

it("searches as you type, across every field an agent reads", async () => {
  const client = fakeClient([
    item({ name: "Warm sunset" }),
    item({ name: "Kitchen", usage: "Open a warm travel post" }),
    item({ name: "Snowfall", description: "A cold morning" }),
  ]);
  const screen = await mount(client);
  await expect
    .element(screen.getByRole("button", { name: "Delete Snowfall" }))
    .toBeVisible();

  await screen.getByRole("searchbox", { name: "Search the library" }).fill("warm");
  await expect
    .element(screen.getByRole("button", { name: "Delete Snowfall" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Delete Warm sunset" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Kitchen" }))
    .toBeVisible();

  await screen
    .getByRole("searchbox", { name: "Search the library" })
    .fill("nothing here");
  await expect.element(screen.getByText("Nothing matches that search.")).toBeVisible();
});

it("switches between backgrounds and assets by route", async () => {
  const client = fakeClient([
    item({ name: "Beach", kind: "background" }),
    item({ name: "Logo", kind: "asset" }),
  ]);
  const screen = await mount(client);
  await expect
    .element(screen.getByRole("button", { name: "Delete Beach" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Logo" }))
    .not.toBeInTheDocument();

  await screen.getByRole("link", { name: "Assets" }).click();

  await expect.element(screen.getByRole("heading", { name: "Assets" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Delete Logo" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Beach" }))
    .not.toBeInTheDocument();
  await expect.poll(() => document.title).toBe("Assets · Slide Studio");
});

it("sorts by least used", async () => {
  const client = fakeClient([
    item({
      name: "Overused",
      updatedAt: 900,
      stats: { timesUsed: 9, slideshowCount: 4, firstUsedAt: 1, lastUsedAt: 90 },
    }),
    item({
      name: "Fresh",
      updatedAt: 500,
      stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
    }),
    item({
      name: "Once",
      updatedAt: 100,
      stats: { timesUsed: 1, slideshowCount: 1, firstUsedAt: 1, lastUsedAt: 50 },
    }),
  ]);
  const screen = await mount(client);
  // Recently updated first, so the least used order below is not the arrival one.
  await expect.poll(gridOrder).toEqual(["Overused", "Fresh", "Once"]);

  await screen.getByRole("combobox", { name: "Order" }).click();
  await screen.getByRole("option", { name: "Least used" }).click();

  await expect.poll(gridOrder).toEqual(["Fresh", "Once", "Overused"]);
});

it("shows how often each item has been used", async () => {
  const now = Date.now();
  const client = fakeClient([
    item({
      name: "Sunset",
      width: 1200,
      height: 1600,
      stats: { timesUsed: 5, slideshowCount: 2, firstUsedAt: 1, lastUsedAt: now - DAY },
    }),
    item({ name: "Unused" }),
  ]);
  const screen = await mount(client);
  await expect
    .element(
      screen.getByText("1200 × 1600 · 5 uses across 2 slideshows · last used yesterday"),
    )
    .toBeVisible();
  await expect.element(screen.getByText("1080 × 1920 · never used")).toBeVisible();
});

it("warns which slideshows break before deleting an item in use", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  client.usedBy.set(target.id, [
    { id: "p1", name: "Morning routine" },
    { id: "p2", name: "Beach trip" },
  ]);
  const screen = await mount(client);

  await screen.getByRole("button", { name: "Delete Sunset" }).click();

  const dialog = screen.getByRole("alertdialog", { name: "Delete Sunset?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(screen.getByText("Morning routine, Beach trip")).toBeVisible();
  // The refused attempt is the only delete so far, and it did not force.
  expect(client.deleted).toEqual([{ id: target.id, force: false }]);
  // Radix makes the page behind the dialog inert, so the card is proved to
  // survive through the server's own copy rather than through a query.
  expect(client.items.map((entry) => entry.name)).toEqual(["Sunset"]);
});

it("deletes anyway when the warning is confirmed", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  client.usedBy.set(target.id, [{ id: "p1", name: "Morning routine" }]);
  const screen = await mount(client);

  await screen.getByRole("button", { name: "Delete Sunset" }).click();
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
  await screen.getByRole("button", { name: "Delete anyway" }).click();

  // The toast is written only once the forced delete has answered, so it is
  // what makes the two assertions below about a finished delete rather than a
  // started one.
  await expect.element(screen.getByText("Sunset deleted")).toBeVisible();
  expect(client.deleted).toEqual([
    { id: target.id, force: false },
    { id: target.id, force: true },
  ]);
  await expect
    .element(screen.getByRole("button", { name: "Delete Sunset" }))
    .not.toBeInTheDocument();
});

it("still offers a way through when the server names no slideshow", async () => {
  // The server always sends the list today. A future one that stops must not
  // leave a person reading "It is used by ." with no way forward.
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  let refusals = 0;
  const real = client.deleteLibraryItem;
  client.deleteLibraryItem = (id: string, options: { force?: boolean } = {}) => {
    if (options.force !== true) {
      refusals += 1;
      return Promise.reject(new ApiError(409, "That image is in use.", { usedBy: [] }));
    }
    return real(id, options);
  };
  const screen = await mount(client);

  await screen.getByRole("button", { name: "Delete Sunset" }).click();
  const dialog = screen.getByRole("alertdialog", { name: "Delete Sunset?" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(screen.getByText("the server did not say which one", { exact: false }))
    .toBeVisible();
  expect(refusals).toBe(1);

  await screen.getByRole("button", { name: "Delete anyway" }).click();
  await expect.element(screen.getByText("Sunset deleted")).toBeVisible();
  expect(client.items.map((entry) => entry.name)).toEqual([]);
  // The refusal is counted above rather than here: it never reaches the fake's
  // own recorder, because this test's wrapper answers it.
  expect(client.deleted).toEqual([{ id: target.id, force: true }]);
});

it("keeps the item when the warning is cancelled", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  client.usedBy.set(target.id, [{ id: "p1", name: "Morning routine" }]);
  const screen = await mount(client);

  await screen.getByRole("button", { name: "Delete Sunset" }).click();
  await expect.element(screen.getByRole("alertdialog")).toBeVisible();
  await screen.getByRole("button", { name: "Cancel" }).click();

  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(client.deleted).toEqual([{ id: target.id, force: false }]);
  await expect
    .element(screen.getByRole("button", { name: "Delete Sunset" }))
    .toBeVisible();
});

it("deletes an unused item without asking anything", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  await screen.getByRole("button", { name: "Delete Sunset" }).click();

  // Waiting on the toast first, so the dialog's absence below is a decision the
  // page reached rather than one it had not got to yet.
  await expect.element(screen.getByText("Sunset deleted")).toBeVisible();
  expect(client.deleted).toEqual([{ id: target.id, force: false }]);
  await expect
    .element(screen.getByRole("button", { name: "Delete Sunset" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("edits an item's description in place", async () => {
  const client = fakeClient([item({ name: "Sunset", description: "Old words" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  const description = screen.getByRole("textbox", {
    name: "Description · what it shows",
  });
  await description.fill("A wide sunset over an empty beach");
  await screen.getByRole("textbox", { name: "Name" }).click();

  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(client.patched).toEqual([
    { id: target.id, patch: { description: "A wide sunset over an empty beach" } },
  ]);
  expect((client.items[0] as LibraryItem).description).toBe(
    "A wide sunset over an empty beach",
  );
});

it("saves a single line field on Enter, without leaving it", async () => {
  // app.js:1435 bound the DOM's own change event, which an input fires on Enter
  // as well as on blur. Losing that loses muscle memory nobody can name.
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  const name = screen.getByRole("textbox", { name: "Name" });
  await name.fill("Golden hour");
  await userEvent.keyboard("{Enter}");

  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(client.patched).toEqual([{ id: target.id, patch: { name: "Golden hour" } }]);
  // Nothing was blurred, so the field is still where the reader left it.
  await expect.element(name).toHaveFocus();
});

it("leaves Enter alone in a description, where it is a new line", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  const description = screen.getByRole("textbox", {
    name: "Description · what it shows",
  });
  await description.fill("A wide sunset");
  await userEvent.keyboard("{Enter}over an empty beach");

  // Changing the name last gives the list below a fixed end. An Enter that
  // committed would have put a third patch in it, before this one.
  await screen.getByRole("textbox", { name: "Name" }).fill("Golden hour");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Saved")).toBeVisible();

  expect(client.patched).toEqual([
    { id: target.id, patch: { description: "A wide sunset\nover an empty beach" } },
    { id: target.id, patch: { name: "Golden hour" } },
  ]);
});

it("shows the tags the server kept, not the ones that were typed", async () => {
  // cleanTags trims, lowercases and drops duplicates. A field still showing
  // "Travel,,  WARM , travel" tells the reader their library holds something
  // it does not, and an agent reads the stored value rather than the field.
  const client = fakeClient([item({ name: "Sunset" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  const tags = screen.getByRole("textbox", { name: "Tags" });
  await tags.fill("Travel,,  WARM , travel ");
  await screen.getByRole("textbox", { name: "Name" }).click();

  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(client.patched).toEqual([
    { id: target.id, patch: { tags: "Travel,,  WARM , travel " } },
  ]);
  await expect.element(tags).toHaveValue("travel, warm");
});

it("never overwrites a field that has been typed in since the save went out", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = client.updateLibraryItem;
  client.updateLibraryItem = async (id: string, patch: LibraryPatch) => {
    await held;
    return real(id, patch);
  };
  const screen = await mount(client);

  const tags = screen.getByRole("textbox", { name: "Tags" });
  await tags.fill("Travel");
  await screen.getByRole("textbox", { name: "Name" }).click();
  // Back into the field while the request is still out.
  await tags.fill("Beach");
  release();

  await expect.element(screen.getByText("Saved")).toBeVisible();
  // "travel" is what the server kept, and it must not land on top of the word
  // being typed right now.
  await expect.element(tags).toHaveValue("Beach");
});

it("offers a way back after the server could not be reached", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  let down = true;
  const real = client.listLibrary;
  client.listLibrary = (query = {}) =>
    down ? Promise.reject(new Error("offline")) : real(query);
  const screen = await mount(client);

  await expect
    .element(screen.getByText("Can’t reach the Slide Studio server", { exact: false }))
    .toBeVisible();

  // The server comes back. Nothing else on this page re-reads the library, so
  // without this the alert would go on saying the server is down.
  down = false;
  await screen.getByRole("button", { name: "Try again" }).click();

  await expect
    .element(screen.getByRole("button", { name: "Delete Sunset" }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Can’t reach the Slide Studio server", { exact: false }))
    .not.toBeInTheDocument();
});

it("starts a slideshow from the header, as every screen but the editor did", async () => {
  const client = fakeClient([]);
  const projects = fakeProjects();
  const screen = await mount(client, "background", projects);

  await screen.getByRole("button", { name: "New slideshow" }).click();

  await expect.element(screen.getByText("Editor for p-new")).toBeVisible();
  expect(projects.created).toBe(1);
});

it("tells the reader what the two agent-facing fields are for", async () => {
  // The one piece of guidance that decides whether this library is worth
  // anything to an agent. app.js:1335.
  const screen = await mount(fakeClient([]));
  await expect
    .element(screen.getByText("An agent reads", { exact: false }))
    .toHaveTextContent(
      "An agent reads description and usage to choose images. Vague entries produce vague slideshows.",
    );
  await expect.element(screen.getByText("Image library")).toBeVisible();
  await expect
    .element(
      screen.getByText("Full-bleed photos an agent can use as the base of a slide."),
    )
    .toBeVisible();
});

it("says what assets are for on the assets tab", async () => {
  const screen = await mount(fakeClient([]), "asset");
  await expect
    .element(
      screen.getByText("Logos, stickers and cut-outs an agent can place on a slide."),
    )
    .toBeVisible();
  await expect.element(screen.getByText("No assets yet", { exact: false })).toBeVisible();
});

it("holds the list still while a person fills it in", async () => {
  /*
   * The bug a tester met while filling a library: the default sort is by
   * updated_at, a PATCH stamps it, so the card just edited jumped to the top and
   * pushed every other card down. The next edit then landed on a different
   * image, and one card ended up wearing another card's tags.
   *
   * app.js:1435-1445 saved the field, updated its cache and stopped. It never
   * re-rendered the list, so the order held.
   */
  const client = fakeClient([
    item({ name: "First", updatedAt: 300 }),
    item({ name: "Second", updatedAt: 200 }),
    item({ name: "Third", updatedAt: 100 }),
  ]);
  const second = client.items[1] as LibraryItem;
  const screen = await mount(client);
  await expect.poll(gridOrder).toEqual(["First", "Second", "Third"]);

  // Fill in the second card, the way the README tells a person to.
  const cards = screen.getByRole("textbox", { name: "Description · what it shows" });
  await cards.nth(1).fill("A wide sunset");
  await screen.getByRole("textbox", { name: "Name" }).nth(1).click();
  await expect.element(screen.getByText("Saved")).toBeVisible();

  // The list has not moved under their hands.
  expect(gridOrder()).toEqual(["First", "Second", "Third"]);

  // So the next edit reaches the card they are still looking at.
  await screen.getByRole("textbox", { name: "Tags" }).nth(1).fill("sunset, warm");
  await screen.getByRole("textbox", { name: "Name" }).nth(1).click();
  await expect.poll(() => client.patched).toHaveLength(2);
  expect(client.patched.map((call) => call.id)).toEqual([second.id, second.id]);
  expect((client.items[1] as LibraryItem).name).toBe("Second");
  expect((client.items[1] as LibraryItem).tags).toEqual(["sunset", "warm"]);
  // The card that was never touched is untouched.
  expect((client.items[0] as LibraryItem).tags).toEqual([]);
  // Still still, after a second save stamped updatedAt a second time. A hold
  // that took the newest value each time would have let the card climb.
  expect(gridOrder()).toEqual(["First", "Second", "Third"]);
});

it("settles the order when the reader asks for a different one", async () => {
  // Holding the list still must not mean freezing it: the sort control is a
  // deliberate act, and it reorders even after an edit has gone through.
  const client = fakeClient([
    item({ name: "First", updatedAt: 300 }),
    item({ name: "Second", updatedAt: 200 }),
    item({ name: "Third", updatedAt: 100 }),
  ]);
  const screen = await mount(client);
  await expect.poll(gridOrder).toEqual(["First", "Second", "Third"]);

  await screen
    .getByRole("textbox", { name: "Description · what it shows" })
    .nth(2)
    .fill("Late");
  await screen.getByRole("textbox", { name: "Name" }).nth(2).click();
  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(gridOrder()).toEqual(["First", "Second", "Third"]);

  // Away and back again through the sort control, which re-reads updated_at.
  await screen.getByRole("combobox", { name: "Order" }).click();
  await screen.getByRole("option", { name: "Least used" }).click();
  await screen.getByRole("combobox", { name: "Order" }).click();
  await screen.getByRole("option", { name: "Recently updated" }).click();

  // Third was edited last, so a settled list puts it first.
  await expect.poll(gridOrder).toEqual(["Third", "First", "Second"]);
});

it("settles the order when the reader searches", async () => {
  const client = fakeClient([
    item({ name: "Sun first", updatedAt: 300 }),
    item({ name: "Sun second", updatedAt: 200 }),
  ]);
  const screen = await mount(client);
  await expect.poll(gridOrder).toEqual(["Sun first", "Sun second"]);

  await screen
    .getByRole("textbox", { name: "Description · what it shows" })
    .nth(1)
    .fill("Late");
  await screen.getByRole("textbox", { name: "Name" }).nth(1).click();
  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(gridOrder()).toEqual(["Sun first", "Sun second"]);

  await screen.getByRole("searchbox", { name: "Search the library" }).fill("sun");
  await expect.poll(gridOrder).toEqual(["Sun second", "Sun first"]);
});

it("puts a freshly uploaded image first without shuffling the rest", async () => {
  const client = fakeClient([
    item({ name: "First", updatedAt: 300 }),
    item({ name: "Second", updatedAt: 200 }),
  ]);
  const screen = await mount(client);
  await expect.poll(gridOrder).toEqual(["First", "Second"]);

  choose([png("newest.png")]);

  await expect.element(screen.getByText("1 image uploaded")).toBeVisible();
  expect(gridOrder()).toEqual(["newest", "First", "Second"]);
});

it("costs nothing to leave a field untouched", async () => {
  const client = fakeClient([item({ name: "Sunset", description: "Old words" })]);
  const target = client.items[0] as LibraryItem;
  const screen = await mount(client);

  // Through all four fields, changing exactly one. The changed field's own
  // "Saved" is what proves the round trip finished, so the count below is the
  // whole story rather than a snapshot taken before the others could fire.
  await screen.getByRole("textbox", { name: "Description · what it shows" }).click();
  await screen.getByRole("textbox", { name: "Usage · when to use it" }).click();
  await screen.getByRole("textbox", { name: "Tags" }).click();
  await screen.getByRole("textbox", { name: "Name" }).fill("Golden hour");
  await screen.getByRole("textbox", { name: "Tags" }).click();

  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(client.patched).toEqual([{ id: target.id, patch: { name: "Golden hour" } }]);
});

it("says a field was not saved when the server refuses it", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  client.updateLibraryItem = () => Promise.reject(new ApiError(500, "Nope", null));
  const screen = await mount(client);

  const description = screen.getByRole("textbox", {
    name: "Description · what it shows",
  });
  await description.fill("A wide sunset");
  await screen.getByRole("textbox", { name: "Name" }).click();

  await expect.element(screen.getByText("Not saved")).toBeVisible();
  // What was typed stays put, so the fix is another blur rather than retyping.
  await expect.element(description).toHaveValue("A wide sunset");
});

it("says so when the server cannot be reached", async () => {
  const client = fakeClient([]);
  client.listLibrary = () => Promise.reject(new Error("offline"));
  const screen = await mount(client);
  await expect
    .element(screen.getByText("Can’t reach the Slide Studio server", { exact: false }))
    .toBeVisible();
});

it("asks the server for the whole library once, however it is searched", async () => {
  // The filter runs in the browser over the cache, as app.js:1309-1312 did, so
  // typing must not put a request per keystroke on the wire.
  const client = fakeClient([item({ name: "Warm sunset" }), item({ name: "Kitchen" })]);
  const screen = await mount(client);
  await expect
    .element(screen.getByRole("button", { name: "Delete Kitchen" }))
    .toBeVisible();
  const before = client.listed.length;
  await screen.getByRole("searchbox", { name: "Search the library" }).fill("warm");
  await expect
    .element(screen.getByRole("button", { name: "Delete Kitchen" }))
    .not.toBeInTheDocument();
  expect(client.listed.length).toBe(before);
});

it("holds focus in the search box while it filters", async () => {
  // app.js:1404-1408 had to put focus back by hand after re-rendering the page.
  const client = fakeClient([item({ name: "Warm sunset" }), item({ name: "Kitchen" })]);
  const screen = await mount(client);
  const search = screen.getByRole("searchbox", { name: "Search the library" });
  await search.fill("warm");
  await expect
    .element(screen.getByRole("button", { name: "Delete Kitchen" }))
    .not.toBeInTheDocument();

  // Awaited rather than read once: a bare document.activeElement asserts the
  // instant it runs, so it fails on a page that has not settled yet and passes
  // on one that never had focus to begin with.
  await expect.element(search).toHaveFocus();
  // Typing on, to prove the caret survived too. app.js:1406-1407 had to put it
  // back at the end of the value by hand after re-rendering the whole page.
  await userEvent.keyboard("er");
  await expect.element(search).toHaveValue("warmer");
});

it("opens each tab on its own unfiltered grid", async () => {
  const client = fakeClient([
    item({ name: "Warm beach", kind: "background" }),
    item({ name: "Warm logo", kind: "asset" }),
    item({ name: "Cold logo", kind: "asset" }),
  ]);
  const screen = await mount(client);
  await screen.getByRole("link", { name: "Assets" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Delete Cold logo" }))
    .toBeVisible();
  // Each tab is its own screen, so it opens on an unfiltered grid.
  await expect
    .element(screen.getByRole("searchbox", { name: "Search the library" }))
    .toHaveValue("");
});

it("marks the tab you are on for a screen reader", async () => {
  const client = fakeClient([]);
  const screen = await mount(client, "asset");
  await expect
    .element(screen.getByRole("link", { name: "Assets" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(screen.getByRole("link", { name: "Backgrounds" }))
    .not.toHaveAttribute("aria-current");
});

it("leaves the grid alone when a save fails, so nothing vanishes", async () => {
  const client = fakeClient([item({ name: "Sunset" })]);
  const failing = vi.fn(() => Promise.reject(new ApiError(500, "Nope", null)));
  client.updateLibraryItem = failing;
  const screen = await mount(client);
  await screen.getByRole("textbox", { name: "Name" }).fill("Golden hour");
  await screen.getByRole("textbox", { name: "Tags" }).click();
  await expect.element(screen.getByText("Not saved")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Sunset" }))
    .toBeVisible();
  expect(failing).toHaveBeenCalledTimes(1);
});
