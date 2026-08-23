import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, addItem } from "./helpers.mjs";
import { isAuthorized, isAllowedHost } from "../server/auth.mjs";

function slideDocument(backgroundId, itemId) {
  return {
    ratio: { w: 9, h: 16 },
    slides: [{ id: "s1", backgroundItemId: backgroundId, texts: [], overlays: itemId ? [{ id: "o1", itemId }] : [] }],
  };
}

test("increments the version on every write", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { projects } = app.services;
  const project = projects.create({ name: "One" });
  assert.equal(project.version, 1);
  assert.equal(projects.save(project.id, { name: "One", document: project, version: 1 }).version, 2);
  assert.equal(projects.save(project.id, { name: "One", document: project, version: 2 }).version, 3);
});

test("rejects a stale write and reports the current state", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { projects } = app.services;
  const project = projects.create({ name: "Guarded" });
  projects.save(project.id, { name: "Guarded", document: project, version: 1 });

  assert.throws(() => projects.save(project.id, { name: "Loser", document: project, version: 1 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.details.currentVersion, 2);
    return true;
  });
  assert.equal(projects.get(project.id).name, "Guarded", "the stale write must not land");
});

test("tracks which slideshows use which library items", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const other = await addItem(library, "asset", "Unused");

  const project = projects.create({ name: "Tracked", document: slideDocument(background.id, asset.id) });
  assert.deepEqual(library.usedBy(background.id).map((p) => p.name), ["Tracked"]);
  assert.deepEqual(library.usedBy(asset.id).map((p) => p.name), ["Tracked"]);
  assert.deepEqual(library.usedBy(other.id), []);

  // Dropping the overlay must drop the usage record with it.
  projects.save(project.id, { name: "Tracked", document: slideDocument(background.id, null), version: project.version });
  assert.deepEqual(library.usedBy(asset.id), []);
  assert.deepEqual(library.usedBy(background.id).map((p) => p.name), ["Tracked"]);
});

test("clears usage when a slideshow is deleted", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const project = projects.create({ name: "Doomed", document: slideDocument(background.id, null) });
  projects.remove(project.id);
  assert.deepEqual(library.usedBy(background.id), []);
  assert.equal(projects.get(project.id), null);
});

test("falls back to the default ratio for nonsense input", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const project = app.services.projects.create({ name: "Odd", document: { ratio: { w: 0, h: -3 }, slides: [] } });
  assert.deepEqual(project.ratio, { w: 9, h: 16 });
});

test("reports a missing slideshow as 404", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  assert.throws(() => app.services.projects.require("nope"), (error) => error.status === 404);
});

test("summaries carry the cover and slide count without the document", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Cover");
  projects.create({ name: "Listed", document: slideDocument(background.id, null) });
  const [summary] = projects.list();
  assert.equal(summary.slideCount, 1);
  assert.equal(summary.coverUrl, background.url);
  assert.equal(summary.document, undefined);
});

const request = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers, url: "/api/health" });

test("loopback skips the token and everything else needs it", () => {
  assert.equal(isAuthorized(request("127.0.0.1"), "secret"), true);
  assert.equal(isAuthorized(request("::1"), "secret"), true);
  assert.equal(isAuthorized(request("192.168.1.20"), "secret"), false);
  assert.equal(isAuthorized(request("192.168.1.20", { authorization: "Bearer secret" }), "secret"), true);
  assert.equal(isAuthorized(request("192.168.1.20", { authorization: "Bearer wrong" }), "secret"), false);
  assert.equal(isAuthorized(request("192.168.1.20", { authorization: "Bearer secretlonger" }), "secret"), false);
});

test("only allows known Host headers", () => {
  const allowed = ["localhost", "127.0.0.1"];
  assert.equal(isAllowedHost(request("127.0.0.1", { host: "localhost:4173" }), allowed), true);
  assert.equal(isAllowedHost(request("127.0.0.1", { host: "127.0.0.1:4173" }), allowed), true);
  assert.equal(isAllowedHost(request("127.0.0.1", { host: "evil.example.com" }), allowed), false);
});
