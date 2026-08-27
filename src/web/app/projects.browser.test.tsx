import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { Project, ProjectSummary } from "@shared/schema/index.js";
import { ProjectsProvider, ProjectsStore, useProjects } from "./projects.js";
import type { ProjectsClient, Subscribe } from "./projects.js";

/*
 * The list store itself. What the dashboard does with it is covered beside the
 * dashboard; this is about the two things a screen cannot see: which answer
 * wins when two reads overlap, and whether the stream is let go on the way out.
 */

function summary(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    version: 1,
    ratio: { w: 9, h: 16 },
    status: "draft",
    description: "",
    hashtags: "",
    accountId: DEFAULT_ACCOUNT_ID,
    slideCount: 0,
    coverItemId: null,
    coverUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const unusedProject: Project = {
  id: "p-new",
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

function Names() {
  const { projects, loading } = useProjects();
  return (
    <p data-loading={String(loading)}>
      {projects.length === 0 ? "none" : projects.map((item) => item.name).join(", ")}
    </p>
  );
}

const noStream: Subscribe = () => () => {};

it("lets the newest read win when two overlap", async () => {
  const pending: ((projects: ProjectSummary[]) => void)[] = [];
  const client: ProjectsClient = {
    listProjects: () =>
      new Promise((resolve) => {
        pending.push((projects) => {
          resolve({ projects });
        });
      }),
    createProject: () => Promise.resolve({ project: unusedProject }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  };

  const store = new ProjectsStore(client);
  const screen = await render(
    <ProjectsProvider store={store} subscribe={noStream}>
      <Names />
    </ProjectsProvider>,
  );
  await expect.element(screen.getByText("none")).toBeVisible();

  void store.refresh();
  await expect.poll(() => pending.length).toBe(2);

  // The second read answers first, then the first one straggles in. The
  // straggler is the stale one, so the screen must keep the newer answer.
  pending[1]?.([summary("b", "Newer answer")]);
  pending[0]?.([summary("a", "Stale answer")]);
  await expect.element(screen.getByText("Newer answer")).toBeVisible();
  await expect.element(screen.getByText("Stale answer")).not.toBeInTheDocument();
});

it("lets the stream go when the app unmounts", async () => {
  let stopped = 0;
  const subscribe: Subscribe = () => () => {
    stopped += 1;
  };
  const client: ProjectsClient = {
    listProjects: () => Promise.resolve({ projects: [] }),
    createProject: () => Promise.resolve({ project: unusedProject }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
  };
  const screen = await render(
    <ProjectsProvider store={new ProjectsStore(client)} subscribe={subscribe}>
      <Names />
    </ProjectsProvider>,
  );
  await expect.element(screen.getByText("none")).toBeVisible();
  screen.unmount();
  expect(stopped).toBeGreaterThanOrEqual(1);
});

it("passes the chosen account to every refresh", async () => {
  const seen: (string | undefined)[] = [];
  const client: ProjectsClient = {
    listProjects: (status, accountId) => {
      seen.push(accountId);
      return Promise.resolve({ projects: [] });
    },
    createProject: () => Promise.reject(new Error("not used")),
    deleteProject: () => Promise.reject(new Error("not used")),
  };
  const store = new ProjectsStore(client);
  await store.refresh();
  store.setAccountFilter("a1");
  await vi.waitFor(() => {
    expect(seen.at(-1)).toBe("a1");
  });
  store.setAccountFilter(undefined);
  await vi.waitFor(() => {
    expect(seen.at(-1)).toBeUndefined();
  });
});

it("creates a slideshow without naming a ratio, so the account's own default applies", async () => {
  // ProjectService.create (src/server/services/projects.ts) only seeds the
  // account's default ratio when the document it is handed carries none of
  // its own — a document sent with DEFAULT_RATIO already filled in silently
  // overrides an account set to anything else. This asserts the client sends
  // no document at all, the same bare-create path POST /api/slideshows and
  // MCP's create_slideshow already take, rather than re-checking the
  // fallback itself, which belongs to the server's own suite.
  let seenDocument: unknown = "not called";
  const client: ProjectsClient = {
    listProjects: () => Promise.resolve({ projects: [] }),
    createProject: (input) => {
      seenDocument = input.document;
      return Promise.resolve({ project: unusedProject });
    },
    deleteProject: () => Promise.reject(new Error("not used")),
  };
  const store = new ProjectsStore(client);
  await store.create("account-1");
  expect(seenDocument).toBeUndefined();
});

it("keeps the account filter and Show published composed, so flipping one never resets the other", async () => {
  const seen: { status: string | undefined; accountId: string | undefined }[] = [];
  const client: ProjectsClient = {
    listProjects: (status, accountId) => {
      seen.push({ status, accountId });
      return Promise.resolve({ projects: [] });
    },
    createProject: () => Promise.reject(new Error("not used")),
    deleteProject: () => Promise.reject(new Error("not used")),
  };
  const store = new ProjectsStore(client);
  await store.refresh();

  store.setAccountFilter("a1");
  await vi.waitFor(() => {
    expect(seen.at(-1)).toEqual({ status: undefined, accountId: "a1" });
  });

  // Show published narrows further within the chosen account, rather than
  // dropping the account filter back to every account.
  store.setShowPublished(true);
  await vi.waitFor(() => {
    expect(seen.at(-1)).toEqual({ status: "all", accountId: "a1" });
  });

  // And the account filter survives Show published being switched off again.
  store.setShowPublished(false);
  await vi.waitFor(() => {
    expect(seen.at(-1)).toEqual({ status: undefined, accountId: "a1" });
  });
});
