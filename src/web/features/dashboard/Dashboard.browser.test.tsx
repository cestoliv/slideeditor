import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { Project, ProjectSummary } from "@shared/schema/index.js";
// The dashboard paints from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
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
    slideCount: 3,
    coverItemId: null,
    coverUrl: null,
    createdAt: 1,
    updatedAt: 1000,
    ...overrides,
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
    createdAt: 1,
    updatedAt: 1,
    ratio: { w: 9, h: 16 },
    slides: [],
  };
}

type Fake = ProjectsClient & {
  projects: ProjectSummary[];
  statuses: (string | undefined)[];
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
    removed: [],
    created: 0,
    listProjects: (status?: string) => {
      fake.statuses.push(status);
      const visible =
        status === "all"
          ? [...fake.projects]
          : fake.projects.filter((item) => item.status !== "published");
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

async function mount(client: ProjectsClient, subscribe: Subscribe = noStream) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <ProjectsProvider store={new ProjectsStore(client)} subscribe={subscribe}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects/:id" element={<EditorProbe />} />
            <Route path="/library/:kind" element={<p>Library</p>} />
          </Routes>
        </ProjectsProvider>
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
  await expect.element(screen.getByText("Editor for p-new")).toBeVisible();
  expect(client.created).toBe(1);
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

it("says the browser is unauthorised rather than blaming the server", async () => {
  const screen = await mount({
    listProjects: () =>
      Promise.reject(new ApiError(401, "Send Authorization: Bearer <token>.", {})),
    createProject: () => Promise.resolve({ project: project("p-new") }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  });
  await expect
    .element(screen.getByText("This browser is not authorised", { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Start it with npm start", { exact: false }))
    .not.toBeInTheDocument();
  // The recovery has to name what the reader can actually do. bannerLines
  // (src/server/cli.ts:66-78) prints the base URL and the token on two separate
  // lines, so no printed address carries the token and telling them to find one
  // sends them hunting for something that does not exist. README:229-230 has
  // the real instruction: append it yourself.
  await expect
    .element(screen.getByText("?token=<token>", { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByText("~/.slide-studio/token", { exact: false }))
    .toBeVisible();
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
