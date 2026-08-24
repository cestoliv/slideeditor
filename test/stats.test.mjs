import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, addItem } from "./helpers.mjs";

function document(slides) {
  return { ratio: { w: 9, h: 16 }, slides };
}

const slide = (backgroundId, itemIds = []) => ({
  id: `s${Math.random()}`,
  backgroundItemId: backgroundId,
  texts: [],
  overlays: itemIds.map((itemId, index) => ({ id: `o${index}${Math.random()}`, itemId })),
});

test("counts every placement, not just distinct items", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");

  // The same asset twice on one slide, once on another.
  projects.create({ name: "One", document: document([slide(background.id, [asset.id, asset.id]), slide(background.id, [asset.id])]) });

  assert.equal(library.get(asset.id).stats.timesUsed, 3);
  assert.equal(library.get(asset.id).stats.slideshowCount, 1);
  assert.equal(library.get(background.id).stats.timesUsed, 2, "a background counts once per slide");
});

test("adds up across slideshows", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");

  projects.create({ name: "One", document: document([slide(background.id, [asset.id])]) });
  projects.create({ name: "Two", document: document([slide(background.id, [asset.id, asset.id])]) });

  const stats = library.get(asset.id).stats;
  assert.equal(stats.timesUsed, 3);
  assert.equal(stats.slideshowCount, 2);
});

test("keeps history after the slideshow is deleted", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const project = projects.create({ name: "Doomed", document: document([slide(background.id, [asset.id, asset.id])]) });

  const before = library.get(asset.id).stats;
  projects.remove(project.id);
  const after = library.get(asset.id).stats;

  assert.deepEqual(after, before, "deleting a slideshow must not make an item look unused");
  assert.equal(after.timesUsed, 2);
  assert.deepEqual(library.usedBy(asset.id), [], "the live index still clears, so the delete warning stays honest");
});

test("tracks the current placement count on re-save", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const project = projects.create({ name: "Edited", document: document([slide(background.id, [asset.id, asset.id])]) });
  assert.equal(library.get(asset.id).stats.timesUsed, 2);

  projects.save(project.id, { name: "Edited", version: project.version, document: document([slide(background.id, [asset.id])]) });
  assert.equal(library.get(asset.id).stats.timesUsed, 1, "removing an overlay is reflected while the slideshow exists");
  assert.equal(library.get(asset.id).stats.slideshowCount, 1);
});

test("reports never-used items as zero", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const item = await addItem(app.services.library, "asset", "Untouched");
  assert.deepEqual(app.services.library.get(item.id).stats, {
    timesUsed: 0,
    slideshowCount: 0,
    firstUsedAt: null,
    lastUsedAt: null,
  });
});

test("sorts least-used first so an agent can vary its choices", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const heavy = await addItem(library, "asset", "Heavy");
  const light = await addItem(library, "asset", "Light");
  const never = await addItem(library, "asset", "Never");

  projects.create({ name: "One", document: document([slide(background.id, [heavy.id, heavy.id, heavy.id, light.id])]) });

  assert.deepEqual(library.list({ kind: "asset", sort: "least-used" }).items.map((i) => i.name), ["Never", "Light", "Heavy"]);
  assert.deepEqual(library.list({ kind: "asset", sort: "most-used" }).items.map((i) => i.name), ["Heavy", "Light", "Never"]);
  assert.equal(never.id && library.get(never.id).stats.timesUsed, 0);
});

test("applies a sort to search results too", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const heavy = await addItem(library, "asset", "Arrow one", { description: "an arrow" });
  await addItem(library, "asset", "Arrow two", { description: "an arrow" });
  projects.create({ name: "One", document: document([slide(background.id, [heavy.id])]) });

  const names = library.list({ kind: "asset", query: "arrow", sort: "least-used" }).items.map((i) => i.name);
  assert.deepEqual(names, ["Arrow two", "Arrow one"]);
});
