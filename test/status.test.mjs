import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./helpers.mjs";
import { normalizeStatusFilter } from "../server/projects.mjs";

test("starts every slideshow as a draft", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  assert.equal(app.services.projects.create({ name: "New" }).status, "draft");
});

test("hides published slideshows from the default list", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { projects } = app.services;
  const draft = projects.create({ name: "Draft" });
  const ready = projects.create({ name: "Ready" });
  const done = projects.create({ name: "Done" });
  projects.setStatus(ready.id, "ready");
  projects.setStatus(done.id, "published");

  assert.deepEqual(projects.list().map((p) => p.name).sort(), ["Draft", "Ready"]);
  assert.deepEqual(projects.list({ status: "all" }).map((p) => p.name).sort(), ["Done", "Draft", "Ready"]);
  assert.deepEqual(projects.list({ status: "published" }).map((p) => p.name), ["Done"]);
  assert.deepEqual(projects.list({ status: "draft,published" }).map((p) => p.name).sort(), ["Done", "Draft"]);
  assert.equal(draft.status, "draft");
});

test("leaves the version alone when the status changes", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { projects } = app.services;
  const project = projects.create({ name: "Labelled" });
  projects.save(project.id, { name: "Labelled", document: project, version: 1 });
  const before = projects.get(project.id).version;

  projects.setStatus(project.id, "ready");

  const after = projects.get(project.id);
  assert.equal(after.version, before, "marking ready must not make an open editor's next save conflict");
  assert.equal(after.status, "ready");
});

test("keeps the status when the document is edited", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { projects } = app.services;
  const project = projects.create({ name: "Posted" });
  projects.setStatus(project.id, "published");
  projects.save(project.id, { name: "Posted", document: { ratio: { w: 1, h: 1 }, slides: [] }, version: project.version });
  assert.equal(projects.get(project.id).status, "published", "published is a label, not a lock");
});

test("announces a status change on the event stream", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const seen = [];
  app.events.broadcast = (payload) => seen.push(payload);
  const project = app.services.projects.create({ name: "Watched" });
  app.services.projects.setStatus(project.id, "ready");
  assert.deepEqual(seen.at(-1), { type: "project.status", projectId: project.id, status: "ready" });
});

test("rejects an unknown status", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const project = app.services.projects.create({ name: "Strict" });
  assert.throws(() => app.services.projects.setStatus(project.id, "archived"), (error) => error.status === 400);
  assert.throws(() => normalizeStatusFilter("archived"), (error) => error.status === 400);
});

test("normalizes status filters", () => {
  assert.deepEqual(normalizeStatusFilter("all"), ["draft", "ready", "published"]);
  assert.deepEqual(normalizeStatusFilter("draft"), ["draft"]);
  assert.deepEqual(normalizeStatusFilter(" READY , draft "), ["ready", "draft"]);
  assert.deepEqual(normalizeStatusFilter(["draft", "draft"]), ["draft"]);
});
