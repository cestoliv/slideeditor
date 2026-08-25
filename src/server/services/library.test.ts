import { afterEach, expect, it } from "vitest";
import {
  asHttpError,
  catchError,
  createTestApp,
  addItem,
  solidPng,
  type TestApp,
} from "../testing.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

it("stores identical bytes once", async () => {
  app = createTestApp();
  const { library } = app.services;
  const one = await addItem(library, "background", "First");
  const two = await addItem(library, "background", "Second");
  expect(one.mediaId, "same bytes must share one media file").toBe(two.mediaId);
  expect(one.id, "but they stay separate library entries").not.toBe(two.id);
});

it("trusts the file header over client-supplied dimensions", async () => {
  app = createTestApp();
  const item = await app.services.library.create({
    kind: "asset",
    name: "Liar",
    contentType: "image/png",
    bytes: solidPng(300, 200),
    width: 9999,
    height: 9999,
  });
  expect(item.width).toBe(300);
  expect(item.height).toBe(200);
});

it("rejects an unsupported content type", async () => {
  app = createTestApp();
  const { library } = app.services;
  const error = asHttpError(
    await catchError(() =>
      library.create({
        kind: "asset",
        name: "Bad",
        contentType: "application/pdf",
        bytes: Buffer.from("x"),
      }),
    ),
  );
  expect(error.status).toBe(415);
});

it("searches name, description, usage and tags", async () => {
  app = createTestApp();
  const { library } = app.services;
  await addItem(library, "background", "Sunset beach", {
    description: "warm orange sky",
    usage: "opening slide for travel",
    tags: "travel",
  });
  await addItem(library, "background", "Studio grey", {
    description: "neutral backdrop",
    usage: "when text must carry the slide",
  });
  await addItem(library, "asset", "Arrow", {
    usage: "push the viewer to the next slide",
  });

  expect(library.list({ query: "travel" }).items.map((item) => item.name)).toEqual([
    "Sunset beach",
  ]);
  expect(library.list({ query: "neutral" }).items.map((item) => item.name)).toEqual([
    "Studio grey",
  ]);
  expect(
    library.list({ query: "slide", kind: "asset" }).items.map((item) => item.name),
  ).toEqual(["Arrow"]);
  expect(
    library.list({ query: "sunse" }).items.map((item) => item.name),
    "prefix search must work",
  ).toEqual(["Sunset beach"]);
  expect(library.list({ query: "nothingmatches" }).items).toEqual([]);
});

it("survives punctuation that would otherwise be FTS syntax", async () => {
  app = createTestApp();
  const { library } = app.services;
  await addItem(library, "asset", "Logo", { description: "the wordmark" });
  expect(() => library.list({ query: '"* OR (' })).not.toThrow();
});

it("keeps search in step with edits", async () => {
  app = createTestApp();
  const { library } = app.services;
  const item = await addItem(library, "asset", "Placeholder", {
    description: "temporary",
  });
  library.update(item.id, { description: "a gold star badge" });
  expect(library.list({ query: "gold" }).items.map((item) => item.name)).toEqual([
    "Placeholder",
  ]);
  expect(library.list({ query: "temporary" }).items).toEqual([]);
});

it("refuses to delete an item that slides depend on, then allows it with force", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "In use");
  projects.create({
    name: "Uses it",
    document: {
      ratio: { w: 9, h: 16 },
      slides: [{ id: "s1", backgroundItemId: background.id, texts: [], overlays: [] }],
    },
  });

  const error = asHttpError(await catchError(() => library.remove(background.id)));
  expect(error.status).toBe(409);
  const details = error.details as { usedBy: { name: string }[] };
  expect(details.usedBy.map((project) => project.name)).toEqual(["Uses it"]);

  const result = await library.remove(background.id, { force: true });
  expect(result.brokeSlideshows.length).toBe(1);
  expect(library.get(background.id)).toBeNull();
});

it("keeps shared bytes on disk while another item still points at them", async () => {
  app = createTestApp();
  const { library, media } = app.services;
  const one = await addItem(library, "background", "One");
  const two = await addItem(library, "background", "Two");
  await library.remove(one.id);
  expect(
    media.exists(two.mediaId, two.ext),
    "the surviving item must keep its file",
  ).toBe(true);
  await library.remove(two.id);
  expect(media.exists(two.mediaId, two.ext), "the last reference removes the file").toBe(
    false,
  );
});

// ---------------------------------------------------------------------------
// New with the port.

it("reports the whole library in total, not the page", async () => {
  app = createTestApp();
  const { library } = app.services;
  for (const name of ["One", "Two", "Three"])
    await addItem(library, "asset", name, { usage: name });
  await addItem(library, "background", "Backdrop");

  const page = library.list({ limit: 2 });
  expect(page.items.length, "the page is capped by limit").toBe(2);
  expect(page.total, "total counts every item, not the page").toBe(4);
  expect(
    library.list({ limit: 2, offset: 2 }).total,
    "and does not move with the offset",
  ).toBe(4);
  expect(
    library.list({ kind: "asset", limit: 1 }).total,
    "a kind filter narrows it",
  ).toBe(3);
  expect(library.list({ kind: "background" }).total).toBe(1);
});

it("reports the page size as the total of a search, which is the inherited bug", async () => {
  app = createTestApp();
  const { library } = app.services;
  for (const name of ["Arrow one", "Arrow two", "Arrow three"]) {
    await addItem(library, "asset", name, { description: "an arrow" });
  }

  // Pinning today's answer, not endorsing it. server/library.mjs:81 returned
  // rows.length, so the total of a search is the size of the page that came
  // back. Task 7 carries it rather than changing a live API response.
  const page = library.list({ query: "arrow", limit: 2 });
  expect(page.items.length).toBe(2);
  expect(page.total, "the match count is 3, and this reports the page").toBe(2);
  expect(
    library.list({ query: "arrow" }).total,
    "a page big enough to hold them agrees with the truth",
  ).toBe(3);
  expect(library.list({ query: "nothingmatches" }).total).toBe(0);
});

it("truncates a long text field at 4000 characters", async () => {
  app = createTestApp();
  const { library } = app.services;
  const item = await addItem(library, "asset", "Wordy", {
    description: "d".repeat(5000),
  });
  expect(item.description.length).toBe(4000);
  expect(library.update(item.id, { usage: "u".repeat(5000) }).usage.length).toBe(4000);
});

it("stores identical bytes once and reports both items", async () => {
  app = createTestApp();
  const { library, media } = app.services;
  const one = await addItem(library, "background", "First");
  const two = await addItem(library, "background", "Second");

  expect(one.mediaId).toBe(two.mediaId);
  expect(media.exists(one.mediaId, one.ext)).toBe(true);
  const names = library.list().items.map((item) => item.name);
  expect(names.sort()).toEqual(["First", "Second"]);
  expect(library.count()).toBe(2);
});

it("keeps the media file when another item still points at it", async () => {
  app = createTestApp();
  const { library, media } = app.services;
  const one = await addItem(library, "asset", "One");
  const two = await addItem(library, "asset", "Two");
  await library.remove(one.id);
  expect(media.exists(two.mediaId, two.ext)).toBe(true);
  expect(library.get(two.id)?.mediaId).toBe(one.mediaId);
});

it("refuses to delete an item in use and names the slideshows", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const asset = await addItem(library, "asset", "Wanted");
  const background = await addItem(library, "background", "Bg");
  projects.create({
    name: "Second show",
    document: { ratio: { w: 9, h: 16 }, slides: [slide(background.id, [asset.id])] },
  });
  projects.create({
    name: "First show",
    document: { ratio: { w: 9, h: 16 }, slides: [slide(background.id, [asset.id])] },
  });

  const error = asHttpError(await catchError(() => library.remove(asset.id)));
  expect(error.status).toBe(409);
  expect(error.message).toBe("Wanted is used by 2 slideshows.");
  const details = error.details as { usedBy: { id: string; name: string }[] };
  expect(
    details.usedBy.map((project) => project.name),
    "named in project name order",
  ).toEqual(["First show", "Second show"]);
  expect(library.get(asset.id), "the refusal must leave the item alone").not.toBeNull();
});

it("deletes an item in use when force is set", async () => {
  app = createTestApp();
  const { library, projects, media } = app.services;
  // Distinct pixels, so the background does not share the asset's media file.
  const asset = await addItem(library, "asset", "Doomed", { width: 400, height: 300 });
  const background = await addItem(library, "background", "Bg");
  const project = projects.create({
    name: "Broken by this",
    document: { ratio: { w: 9, h: 16 }, slides: [slide(background.id, [asset.id])] },
  });

  const result = await library.remove(asset.id, { force: true });
  expect(result.removed).toBe(asset.id);
  expect(result.brokeSlideshows.map((entry) => entry.id)).toEqual([project.id]);
  expect(library.get(asset.id)).toBeNull();
  expect(media.exists(asset.mediaId, asset.ext), "nothing else points at the bytes").toBe(
    false,
  );
  expect(library.usedBy(asset.id)).toEqual([]);
});

it("sorts least-used first, never-used before used", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  // Created heavy, never, light, so neither answer below is the order the
  // items were added in. A sort that quietly fell back to recency would show.
  const heavy = await addItem(library, "asset", "Heavy");
  const never = await addItem(library, "asset", "Never");
  const light = await addItem(library, "asset", "Light");
  projects.create({
    name: "One",
    document: {
      ratio: { w: 9, h: 16 },
      slides: [slide(background.id, [heavy.id, heavy.id, heavy.id, light.id])],
    },
  });

  expect(
    library.list({ kind: "asset", sort: "least-used" }).items.map((item) => item.name),
  ).toEqual(["Never", "Light", "Heavy"]);
  expect(
    library.list({ kind: "asset", sort: "most-used" }).items.map((item) => item.name),
  ).toEqual(["Heavy", "Light", "Never"]);
  expect(library.get(never.id)?.stats.timesUsed, "never used means zero, not null").toBe(
    0,
  );
});

it("finds an item by a prefix of a word in its usage note", async () => {
  app = createTestApp();
  const { library } = app.services;
  await addItem(library, "asset", "Pointer", {
    usage: "push the viewer to the next slide",
  });
  await addItem(library, "asset", "Other", { usage: "nothing alike" });
  expect(library.list({ query: "view" }).items.map((item) => item.name)).toEqual([
    "Pointer",
  ]);
});

it("rejects an unsupported content type with 415", async () => {
  app = createTestApp();
  const { library } = app.services;
  const error = asHttpError(
    await catchError(() =>
      library.create({
        kind: "asset",
        name: "Bad",
        contentType: "image/tiff",
        bytes: solidPng(2, 2),
      }),
    ),
  );
  expect(error.status).toBe(415);
  expect(error.message).toBe("Unsupported image type: image/tiff");
});

it("rejects an upload over 25MB with 413", async () => {
  app = createTestApp();
  const { library } = app.services;
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
  const error = asHttpError(
    await catchError(() =>
      library.create({
        kind: "asset",
        name: "Huge",
        contentType: "image/png",
        bytes: oversized,
      }),
    ),
  );
  expect(error.status).toBe(413);
  expect(error.message).toBe("Images must be 25MB or smaller.");
});

it("accepts an upload of exactly 25MB", async () => {
  app = createTestApp();
  const { library } = app.services;
  // A real PNG header on the front, then padding out to the limit.
  const png = solidPng(4, 4);
  const bytes = Buffer.concat([png, Buffer.alloc(25 * 1024 * 1024 - png.length)]);
  const item = await library.create({
    kind: "asset",
    name: "Exactly",
    contentType: "image/png",
    bytes,
  });
  expect(item.width).toBe(4);
});

function slide(backgroundItemId: string, itemIds: string[]): unknown {
  return {
    id: `s-${backgroundItemId}-${itemIds.join("-")}`,
    backgroundItemId,
    texts: [],
    overlays: itemIds.map((itemId, index) => ({ id: `o${index}`, itemId })),
  };
}
