import { afterEach, expect, it } from "vitest";
import { asHttpError, catchError, createTestApp, type TestApp } from "../testing.js";
import { normalizeStatusFilter } from "./projects.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

it("starts every slideshow as a draft", () => {
  app = createTestApp();
  expect(app.services.projects.create({ name: "New" }).status).toBe("draft");
});

it("hides published slideshows from the default list", () => {
  app = createTestApp();
  const { projects } = app.services;
  const draft = projects.create({ name: "Draft" });
  const ready = projects.create({ name: "Ready" });
  const done = projects.create({ name: "Done" });
  projects.setStatus(ready.id, "ready");
  projects.setStatus(done.id, "published");

  expect(
    projects
      .list()
      .map((project) => project.name)
      .sort(),
  ).toEqual(["Draft", "Ready"]);
  expect(
    projects
      .list({ status: "all" })
      .map((project) => project.name)
      .sort(),
  ).toEqual(["Done", "Draft", "Ready"]);
  expect(projects.list({ status: "published" }).map((project) => project.name)).toEqual([
    "Done",
  ]);
  expect(
    projects
      .list({ status: "draft,published" })
      .map((project) => project.name)
      .sort(),
  ).toEqual(["Done", "Draft"]);
  expect(draft.status).toBe("draft");
});

it("leaves the version alone when the status changes", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Labelled" });
  projects.save(project.id, { name: "Labelled", document: project, version: 1 });
  const before = projects.get(project.id)?.version;

  projects.setStatus(project.id, "ready");

  const after = projects.get(project.id);
  expect(
    after?.version,
    "marking ready must not make an open editor's next save conflict",
  ).toBe(before);
  expect(after?.status).toBe("ready");
});

it("keeps the status when the document is edited", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Posted" });
  projects.setStatus(project.id, "published");
  projects.save(project.id, {
    name: "Posted",
    document: { ratio: { w: 1, h: 1 }, slides: [] },
    version: project.version,
  });
  expect(projects.get(project.id)?.status, "published is a label, not a lock").toBe(
    "published",
  );
});

it("announces a status change on the event stream", () => {
  app = createTestApp();
  const seen: unknown[] = [];
  app.events.broadcast = (payload) => seen.push(payload);
  const project = app.services.projects.create({ name: "Watched" });
  app.services.projects.setStatus(project.id, "ready");
  expect(seen.at(-1)).toEqual({
    type: "project.status",
    projectId: project.id,
    status: "ready",
  });
});

it("rejects an unknown status", async () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Strict" });
  const statusError = asHttpError(
    await catchError(() => projects.setStatus(project.id, "archived")),
  );
  expect(statusError.status).toBe(400);
  const filterError = asHttpError(
    await catchError(() => normalizeStatusFilter("archived")),
  );
  expect(filterError.status).toBe(400);
});

it("normalizes status filters", () => {
  expect(normalizeStatusFilter("all")).toEqual(["draft", "ready", "published"]);
  expect(normalizeStatusFilter("draft")).toEqual(["draft"]);
  expect(normalizeStatusFilter(" READY , draft ")).toEqual(["ready", "draft"]);
  expect(normalizeStatusFilter(["draft", "draft"])).toEqual(["draft"]);
});
