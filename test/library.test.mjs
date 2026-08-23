import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, addItem, solidPng } from "./helpers.mjs";
import { imageDimensions } from "../server/media.mjs";

test("reads dimensions from the PNG header", () => {
  assert.deepEqual(imageDimensions(solidPng(640, 480)), { width: 640, height: 480 });
});

test("returns null for a format it cannot decode", () => {
  assert.equal(imageDimensions(Buffer.from("<svg width='10'/>")), null);
});

test("stores identical bytes once", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library } = app.services;
  const one = await addItem(library, "background", "First");
  const two = await addItem(library, "background", "Second");
  assert.equal(one.mediaId, two.mediaId, "same bytes must share one media file");
  assert.notEqual(one.id, two.id, "but they stay separate library entries");
});

test("trusts the file header over client-supplied dimensions", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const item = await app.services.library.create({
    kind: "asset",
    name: "Liar",
    contentType: "image/png",
    bytes: solidPng(300, 200),
    width: 9999,
    height: 9999,
  });
  assert.equal(item.width, 300);
  assert.equal(item.height, 200);
});

test("rejects an unsupported content type", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  await assert.rejects(
    () => app.services.library.create({ kind: "asset", name: "Bad", contentType: "application/pdf", bytes: Buffer.from("x") }),
    (error) => error.status === 415,
  );
});

test("searches name, description, usage and tags", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library } = app.services;
  await addItem(library, "background", "Sunset beach", { description: "warm orange sky", usage: "opening slide for travel", tags: "travel" });
  await addItem(library, "background", "Studio grey", { description: "neutral backdrop", usage: "when text must carry the slide" });
  await addItem(library, "asset", "Arrow", { usage: "push the viewer to the next slide" });

  assert.deepEqual(library.list({ query: "travel" }).items.map((i) => i.name), ["Sunset beach"]);
  assert.deepEqual(library.list({ query: "neutral" }).items.map((i) => i.name), ["Studio grey"]);
  assert.deepEqual(library.list({ query: "slide", kind: "asset" }).items.map((i) => i.name), ["Arrow"]);
  assert.deepEqual(library.list({ query: "sunse" }).items.map((i) => i.name), ["Sunset beach"], "prefix search must work");
  assert.deepEqual(library.list({ query: "nothingmatches" }).items, []);
});

test("survives punctuation that would otherwise be FTS syntax", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  await addItem(app.services.library, "asset", "Logo", { description: "the wordmark" });
  assert.doesNotThrow(() => app.services.library.list({ query: '"* OR (' }));
});

test("keeps search in step with edits", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library } = app.services;
  const item = await addItem(library, "asset", "Placeholder", { description: "temporary" });
  library.update(item.id, { description: "a gold star badge" });
  assert.deepEqual(library.list({ query: "gold" }).items.map((i) => i.name), ["Placeholder"]);
  assert.deepEqual(library.list({ query: "temporary" }).items, []);
});

test("refuses to delete an item that slides depend on, then allows it with force", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "In use");
  projects.create({ name: "Uses it", document: { ratio: { w: 9, h: 16 }, slides: [{ id: "s1", backgroundItemId: background.id, texts: [], overlays: [] }] } });

  await assert.rejects(() => library.remove(background.id), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.details.usedBy.map((p) => p.name), ["Uses it"]);
    return true;
  });
  const result = await library.remove(background.id, { force: true });
  assert.equal(result.brokeSlideshows.length, 1);
  assert.equal(library.get(background.id), null);
});

test("keeps shared bytes on disk while another item still points at them", async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { library, media } = app.services;
  const one = await addItem(library, "background", "One");
  const two = await addItem(library, "background", "Two");
  await library.remove(one.id);
  assert.ok(media.exists(two.mediaId, two.ext), "the surviving item must keep its file");
  await library.remove(two.id);
  assert.equal(media.exists(two.mediaId, two.ext), false, "the last reference removes the file");
});
