import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
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
