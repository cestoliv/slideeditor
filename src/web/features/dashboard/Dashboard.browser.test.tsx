import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { BUILTIN_DEFAULTS, DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { Account, Project, ProjectSummary } from "@shared/schema/index.js";
// The dashboard paints from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../app/accounts.js";
import type { AccountsClient } from "../../app/accounts.js";
import { ProjectsProvider, ProjectsStore } from "../../app/projects.js";
import type { ProjectsClient, Subscribe } from "../../app/projects.js";
import type { ServerEvent } from "@shared/schema/index.js";
import type { StreamStatus } from "../../app/events.js";
import { ApiError } from "../../app/api.js";
import { Dashboard } from "./Dashboard.js";
import { DashboardCard } from "./DashboardCard.js";

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "p1",
    name: "Morning routine",
    version: 1,
    ratio: { w: 9, h: 16 },
    status: "draft",
    description: "",
    hashtags: "",
    accountId: DEFAULT_ACCOUNT_ID,
    slideCount: 3,
    coverItemId: null,
    coverUrl: null,
    createdAt: 1,
    updatedAt: 1000,
    ...overrides,
  };
}

function account(id: string, name: string): Account {
  return { id, name, defaults: BUILTIN_DEFAULTS, createdAt: 1, updatedAt: 1 };
}

/** One account by default, matching every summary()'s accountId, so the picker never blocks a test that isn't about accounts. */
function fakeAccountsClient(
  accounts: Account[] = [account(DEFAULT_ACCOUNT_ID, "Default")],
): AccountsClient {
  return {
    listAccounts: () => Promise.resolve({ accounts }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  };
}

function project(id: string): Project {
  return {
    id,
    name: "New Project",
    version: 1,
    status: "draft",
    description: "",
    hashtags: "",
    accountId: DEFAULT_ACCOUNT_ID,
    createdAt: 1,
    updatedAt: 1,
    ratio: { w: 9, h: 16 },
    slides: [],
  };
}

type Fake = ProjectsClient & {
  projects: ProjectSummary[];
  statuses: (string | undefined)[];
  accountIds: (string | undefined)[];
  removed: string[];
  created: number;
};

/**
 * The server, minus the server. Anything whose status is not in the default
 * filter is withheld unless the caller asks for "all", the way
 * ProjectService.list does.
 */
function fakeClient(projects: ProjectSummary[]): Fake {
  const fake: Fake = {
    projects,
    statuses: [],
    accountIds: [],
    removed: [],
    created: 0,
    listProjects: (status?: string, accountId?: string) => {
      fake.statuses.push(status);
      fake.accountIds.push(accountId);
      const visible = (
        status === "all"
          ? [...fake.projects]
          : fake.projects.filter((item) => item.status !== "published")
      ).filter((item) => accountId === undefined || item.accountId === accountId);
      return Promise.resolve({ projects: visible });
    },
    createProject: () => {
      fake.created += 1;
      return Promise.resolve({ project: project("p-new") });
    },
    deleteProject: (id: string) => {
      fake.removed.push(id);
      const index = fake.projects.findIndex((item) => item.id === id);
      if (index >= 0) fake.projects.splice(index, 1);
      return Promise.resolve({ removed: id });
    },
  };
  return fake;
}

const noStream: Subscribe = () => () => {};

function EditorProbe() {
  const { id } = useParams();
  return <p>Editor for {id}</p>;
}

async function mount(
  client: ProjectsClient,
  subscribe: Subscribe = noStream,
  accounts: Account[] = [account(DEFAULT_ACCOUNT_ID, "Default")],
) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <AccountsProvider store={new AccountsStore(fakeAccountsClient(accounts))}>
          <ProjectsProvider store={new ProjectsStore(client)} subscribe={subscribe}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/projects/:id" element={<EditorProbe />} />
              <Route path="/library/:kind" element={<p>Library</p>} />
            </Routes>
          </ProjectsProvider>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

it("lists slideshows newest first with their slide count", async () => {
  const screen = await mount(
    fakeClient([
      summary({ id: "old", name: "Older", updatedAt: 10, slideCount: 1 }),
      summary({ id: "new", name: "Newest", updatedAt: 900, slideCount: 3 }),
      summary({ id: "mid", name: "Middle", updatedAt: 100, slideCount: 12 }),
    ]),
  );
  const cards = screen.getByRole("button", { name: /^Open / });
  await expect.element(cards.first()).toBeVisible();
  const names = cards.elements().map((card) => card.getAttribute("aria-label"));
  expect(names).toEqual(["Open Newest", "Open Middle", "Open Older"]);
  await expect.element(screen.getByText(/^3 slides ·/)).toBeVisible();
  await expect.element(screen.getByText(/^1 slide ·/)).toBeVisible();
});

it("hides published slideshows until Show published is ticked", async () => {
  const client = fakeClient([
    summary({ id: "draft", name: "Still drafting", status: "draft" }),
    summary({ id: "done", name: "Already out", status: "published" }),
  ]);
  const screen = await mount(client);
  await expect.element(screen.getByText("Still drafting")).toBeVisible();
  await expect.element(screen.getByText("Already out")).not.toBeInTheDocument();

  await screen.getByRole("switch", { name: "Show published" }).click();
  await expect.element(screen.getByText("Already out")).toBeVisible();
  expect(client.statuses).toEqual([undefined, "all"]);
});

it("opens a slideshow when its card is clicked", async () => {
  const screen = await mount(fakeClient([summary()]));
  await screen.getByRole("button", { name: "Open Morning routine" }).click();
  await expect.element(screen.getByText("Editor for p1")).toBeVisible();
});

it("creates a slideshow from the New button and navigates to it", async () => {
  const client = fakeClient([]);
  const screen = await mount(client);
  await screen.getByRole("button", { name: "New slideshow" }).click();
  await screen.getByRole("button", { name: "Create" }).click();
  await expect.element(screen.getByText("Editor for p-new")).toBeVisible();
  expect(client.created).toBe(1);
});

it("narrows the list to the chosen account", async () => {
  const fake = fakeClient([{ ...summary({ id: "p1", name: "Alpha" }) }]);
  const store = new ProjectsStore(fake);
  const screen = await render(
    <MemoryRouter>
      <ToastProvider>
        <AccountsProvider
          store={
            new AccountsStore({
              listAccounts: () =>
                Promise.resolve({
                  accounts: [account("a1", "Main brand"), account("a2", "Side project")],
                }),
              listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
              createAccount: () => Promise.reject(new Error("not used")),
              updateAccount: () => Promise.reject(new Error("not used")),
              deleteAccount: () => Promise.reject(new Error("not used")),
              addGoogleFont: () => Promise.reject(new Error("not used")),
              deleteFont: () => Promise.reject(new Error("not used")),
            })
          }
        >
          <ProjectsProvider store={store} subscribe={noStream}>
            <Dashboard />
          </ProjectsProvider>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  await expect.element(screen.getByText("Alpha")).toBeVisible();
  await userEvent.click(screen.getByLabelText("Account"));
  await userEvent.click(screen.getByRole("option", { name: "Side project" }));
  await expect.poll(() => fake.accountIds.at(-1)).toBe("a2");
});

it("composes the account filter with Show published, narrowing rather than resetting", async () => {
  const client = fakeClient([
    summary({ id: "a-draft", name: "Main draft", accountId: "a1", status: "draft" }),
    summary({
      id: "a-pub",
      name: "Main published",
      accountId: "a1",
      status: "published",
    }),
    summary({ id: "b-draft", name: "Side draft", accountId: "a2", status: "draft" }),
    summary({
      id: "b-pub",
      name: "Side published",
      accountId: "a2",
      status: "published",
    }),
  ]);
  const screen = await mount(client, noStream, [
    account("a1", "Main brand"),
    account("a2", "Side project"),
  ]);

  // Both filters at their defaults: every account, drafts only.
  await expect.element(screen.getByText("Main draft")).toBeVisible();
  await expect.element(screen.getByText("Side draft")).toBeVisible();
  await expect.element(screen.getByText("Main published")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Side published")).not.toBeInTheDocument();

  // Narrow to one account: the published filter still applies alongside it.
  await userEvent.click(screen.getByLabelText("Account"));
  await userEvent.click(screen.getByRole("option", { name: "Main brand" }));
  await expect.element(screen.getByText("Main draft")).toBeVisible();
  await expect.element(screen.getByText("Side draft")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Main published")).not.toBeInTheDocument();

  // Flip Show published while the account filter is still set: it narrows
  // further within that account rather than resetting the account filter
  // back to every account.
  await screen.getByRole("switch", { name: "Show published" }).click();
  await expect.element(screen.getByText("Main draft")).toBeVisible();
  await expect.element(screen.getByText("Main published")).toBeVisible();
  await expect.element(screen.getByText("Side draft")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Side published")).not.toBeInTheDocument();
  expect(client.accountIds.at(-1)).toBe("a1");
  expect(client.statuses.at(-1)).toBe("all");
});

it("resets the account filter to every account when the selected account is deleted", async () => {
  let liveAccounts = [account("a1", "Main brand"), account("a2", "Side project")];
  const accountsStore = new AccountsStore({
    listAccounts: () => Promise.resolve({ accounts: liveAccounts }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: (id: string) => {
      liveAccounts = liveAccounts.filter((item) => item.id !== id);
      return Promise.resolve({ removed: id });
    },
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
  const client = fakeClient([
    summary({ id: "p1", name: "Alpha", accountId: "a1" }),
    summary({ id: "p2", name: "Beta", accountId: "a2" }),
  ]);
  const screen = await render(
    <MemoryRouter>
      <ToastProvider>
        <AccountsProvider store={accountsStore}>
          <ProjectsProvider store={new ProjectsStore(client)} subscribe={noStream}>
            <Dashboard />
          </ProjectsProvider>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  await expect.element(screen.getByText("Alpha")).toBeVisible();

  await userEvent.click(screen.getByLabelText("Account"));
  await userEvent.click(screen.getByRole("option", { name: "Main brand" }));
  await expect.element(screen.getByText("Alpha")).toBeVisible();
  await expect.element(screen.getByText("Beta")).not.toBeInTheDocument();

  // Deleted out from under the filter, not through this screen's own
  // controls — the way another tab, or an agent, would do it.
  await accountsStore.remove("a1");

  await expect
    .element(screen.getByLabelText("Account"))
    .toHaveTextContent("All accounts");
  await expect.element(screen.getByText("Alpha")).toBeVisible();
  await expect.element(screen.getByText("Beta")).toBeVisible();
});

it("asks before deleting and deletes on confirm", async () => {
  const client = fakeClient([summary()]);
  const screen = await mount(client);
  await screen.getByRole("button", { name: "Actions for Morning routine" }).click();
  await screen.getByRole("menuitem", { name: "Remove" }).click();

  const dialog = screen.getByRole("alertdialog", { name: "Remove slideshow?" });
  await expect.element(dialog).toBeVisible();
  expect(client.removed).toEqual([]);

  await screen.getByRole("button", { name: "Remove slideshow" }).click();
  expect(client.removed).toEqual(["p1"]);
  await expect.element(screen.getByText("Morning routine")).not.toBeInTheDocument();
});

it("keeps the slideshow when the confirmation is cancelled", async () => {
  const client = fakeClient([summary()]);
  const screen = await mount(client);
  await screen.getByRole("button", { name: "Actions for Morning routine" }).click();
  await screen.getByRole("menuitem", { name: "Remove" }).click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(client.removed).toEqual([]);
  await expect.element(screen.getByText("Morning routine")).toBeVisible();
});

it("shows an empty state when there is nothing yet", async () => {
  const screen = await mount(fakeClient([]));
  await expect
    .element(screen.getByText("No slideshows yet", { exact: false }))
    .toBeVisible();
});

it("counts what is on screen", async () => {
  const screen = await mount(fakeClient([summary({ id: "a" }), summary({ id: "b" })]));
  await expect.element(screen.getByText("2 slideshows")).toBeVisible();
});

it("says so when the server cannot be reached", async () => {
  const screen = await mount({
    listProjects: () => Promise.reject(new Error("offline")),
    createProject: () => Promise.resolve({ project: project("p-new") }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  });
  await expect
    .element(screen.getByText("Can’t reach the Slide Studio server", { exact: false }))
    .toBeVisible();
});

it("shows a slideshow's status as a badge", async () => {
  const screen = await mount(fakeClient([summary({ status: "ready" })]));
  await expect.element(screen.getByText(/^Ready$/)).toBeVisible();
});

it("shows the cover when the slideshow has one", async () => {
  const screen = await mount(
    fakeClient([summary({ coverItemId: "item-1", coverUrl: "/media/media-1.jpg" })]),
  );
  await expect
    .element(screen.getByRole("img", { name: "Morning routine cover" }))
    .toHaveAttribute("src", "/media/media-1.jpg");
});

it("says a slideshow has no photos yet when it has no cover", async () => {
  const screen = await mount(fakeClient([summary({ slideCount: 0 })]));
  await expect.element(screen.getByText("No photos yet")).toBeVisible();
});

it("refreshes the list when the stream says a slideshow changed", async () => {
  const client = fakeClient([summary()]);
  const stream: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const subscribe: Subscribe = (onEvent) => {
    stream.push = onEvent;
    return () => {};
  };
  const screen = await mount(client, subscribe);
  await expect.element(screen.getByText("Morning routine")).toBeVisible();
  expect(client.statuses).toHaveLength(1);

  // An agent removed it, so the browser learns from the stream, not from a click.
  client.projects.length = 0;
  stream.push?.({ type: "project.removed", projectId: "p1" });
  await expect.element(screen.getByText("Morning routine")).not.toBeInTheDocument();
  expect(client.statuses).toHaveLength(2);
});

/*
 * The card's click target. It looked correct on screen for the whole of the
 * first round while being 318 by 0 pixels, because a click-by-role test passes
 * on a zero-height element. These measure the box instead.
 */

it("gives the whole card to the click target", async () => {
  const screen = await mount(fakeClient([summary()]));
  const target = screen.getByRole("button", { name: "Open Morning routine" }).element();
  const card = target.parentElement;
  if (card === null) throw new Error("The open button has no card around it.");

  const targetBox = target.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  expect(cardBox.height).toBeGreaterThan(200);
  expect(targetBox.height).toBeGreaterThan(200);
  expect(Math.abs(targetBox.height - cardBox.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(targetBox.width - cardBox.width)).toBeLessThanOrEqual(2);
});

it("sizes the click target without leaning on the grid", async () => {
  /*
   * The same card, rendered outside the dashboard's grid. Inside the grid the
   * card is a stretched item and therefore has a definite height, which is the
   * only reason the old `height: 100%` resolved at all. Take the grid away and
   * that rule collapsed the button to zero, because both of its children are
   * out of flow. Positioning the button removes the dependency entirely.
   */
  const screen = await render(
    <DashboardCard project={summary()} onOpen={() => {}} onRemove={() => {}} />,
  );
  const target = screen.getByRole("button", { name: "Open Morning routine" }).element();
  expect(target.getBoundingClientRect().height).toBeGreaterThan(200);
});

it("leaves no dead zone in the card's footer", async () => {
  const screen = await mount(fakeClient([summary()]));
  const target = screen.getByRole("button", { name: "Open Morning routine" }).element();
  const card = target.parentElement;
  if (card === null) throw new Error("The open button has no card around it.");

  // elementFromPoint reads viewport coordinates and the grid runs past the
  // fold, so the card has to be on screen before it can be probed.
  card.scrollIntoView({ block: "center" });
  const box = card.getBoundingClientRect();
  // The footer strip, left of the inset name row and below the preview. This
  // is the gutter that belongs to no child, so only a button filling the card
  // can answer for it. Kept clear of the corners, which the 18px radius
  // genuinely does exclude from hit testing.
  const hit = document.elementFromPoint(box.left + 4, box.bottom - 40);
  expect(hit).not.toBeNull();
  expect(target.contains(hit)).toBe(true);
});

it("keeps the focus ring out of a clipping ancestor", async () => {
  const screen = await mount(fakeClient([summary()]));
  const target = screen.getByRole("button", { name: "Open Morning routine" }).element();
  const card = target.parentElement;
  if (card === null) throw new Error("The open button has no card around it.");

  // reset.css draws the ring as an outline plus an outward box-shadow, and a
  // clipping ancestor eats both, so neither the target nor the card may clip.
  for (const node of [target, card]) {
    expect(window.getComputedStyle(node).overflow).not.toBe("hidden");
  }
});

it("says the browser is not signed in rather than blaming the server", async () => {
  const screen = await mount({
    listProjects: () => Promise.reject(new ApiError(401, "Session expired.", {})),
    createProject: () => Promise.resolve({ project: project("p-new") }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  });
  await expect
    .element(screen.getByText("This browser is not signed in", { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Start it with npm start", { exact: false }))
    .not.toBeInTheDocument();
});

it("keeps the slideshows on screen when a later refresh fails", async () => {
  const client = fakeClient([summary()]);
  const stream: { push: ((event: ServerEvent) => void) | null } = { push: null };
  const subscribe: Subscribe = (onEvent) => {
    stream.push = onEvent;
    return () => {};
  };
  const screen = await mount(client, subscribe);
  await expect.element(screen.getByText("Morning routine")).toBeVisible();

  // The server restarts mid-session and one refresh is dropped. Blanking the
  // list here would empty a populated dashboard over a transient failure.
  client.listProjects = () => Promise.reject(new Error("offline"));
  stream.push?.({ type: "project.changed", projectId: "p1", version: 2 });

  await expect
    .element(screen.getByText("Can’t reach the Slide Studio server", { exact: false }))
    .toBeVisible();
  await expect.element(screen.getByText("Morning routine")).toBeVisible();
});

it("says so when live updates stop", async () => {
  const stream: { status: ((status: StreamStatus) => void) | null } = { status: null };
  const subscribe: Subscribe = (_onEvent, options) => {
    stream.status = options?.onStatus ?? null;
    return () => {};
  };
  const screen = await mount(fakeClient([summary()]), subscribe);
  await expect.element(screen.getByText("Morning routine")).toBeVisible();
  await expect
    .element(screen.getByText("Live updates stopped", { exact: false }))
    .not.toBeInTheDocument();

  stream.status?.("closed");
  await expect
    .element(screen.getByText("Live updates stopped", { exact: false }))
    .toBeVisible();
});

it("keeps quiet about a stream drop the browser will retry", async () => {
  const stream: { status: ((status: StreamStatus) => void) | null } = { status: null };
  const subscribe: Subscribe = (_onEvent, options) => {
    stream.status = options?.onStatus ?? null;
    return () => {};
  };
  const screen = await mount(fakeClient([summary()]), subscribe);
  stream.status?.("retrying");
  await expect.element(screen.getByText("Morning routine")).toBeVisible();
  await expect
    .element(screen.getByText("Live updates stopped", { exact: false }))
    .not.toBeInTheDocument();
});
