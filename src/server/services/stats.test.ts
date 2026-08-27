import { afterEach, expect, it } from "vitest";
import { createTestApp, addItem, type TestApp } from "../testing.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

interface Slide {
  id: string;
  backgroundItemId: string;
  texts: unknown[];
  overlays: { id: string; itemId: string }[];
}

function document(slides: Slide[]): { ratio: { w: number; h: number }; slides: Slide[] } {
  return { ratio: { w: 9, h: 16 }, slides };
}

const slide = (backgroundId: string, itemIds: string[] = []): Slide => ({
  id: `s${Math.random()}`,
  backgroundItemId: backgroundId,
  texts: [],
  overlays: itemIds.map((itemId, index) => ({ id: `o${index}${Math.random()}`, itemId })),
});

it("counts every placement, not just distinct items", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");

  // The same asset twice on one slide, once on another.
  projects.create({
    accountId: "default",
    name: "One",
    document: document([
      slide(background.id, [asset.id, asset.id]),
      slide(background.id, [asset.id]),
    ]),
  });

  expect(library.get(asset.id)?.stats.timesUsed).toBe(3);
  expect(library.get(asset.id)?.stats.slideshowCount).toBe(1);
  expect(
    library.get(background.id)?.stats.timesUsed,
    "a background counts once per slide",
  ).toBe(2);
});

it("adds up across slideshows", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");

  projects.create({
    accountId: "default",
    name: "One",
    document: document([slide(background.id, [asset.id])]),
  });
  projects.create({
    accountId: "default",
    name: "Two",
    document: document([slide(background.id, [asset.id, asset.id])]),
  });

  const stats = library.get(asset.id)?.stats;
  expect(stats?.timesUsed).toBe(3);
  expect(stats?.slideshowCount).toBe(2);
});

it("keeps history after the slideshow is deleted", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const project = projects.create({
    accountId: "default",
    name: "Doomed",
    document: document([slide(background.id, [asset.id, asset.id])]),
  });

  const before = library.get(asset.id)?.stats;
  projects.remove(project.id);
  const after = library.get(asset.id)?.stats;

  expect(after, "deleting a slideshow must not make an item look unused").toEqual(before);
  expect(after?.timesUsed).toBe(2);
  expect(
    library.usedBy(asset.id),
    "the live index still clears, so the delete warning stays honest",
  ).toEqual([]);
});

it("tracks the current placement count on re-save", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const project = projects.create({
    accountId: "default",
    name: "Edited",
    document: document([slide(background.id, [asset.id, asset.id])]),
  });
  expect(library.get(asset.id)?.stats.timesUsed).toBe(2);

  projects.save(project.id, {
    name: "Edited",
    version: project.version,
    document: document([slide(background.id, [asset.id])]),
  });
  expect(
    library.get(asset.id)?.stats.timesUsed,
    "removing an overlay is reflected while the slideshow exists",
  ).toBe(1);
  expect(library.get(asset.id)?.stats.slideshowCount).toBe(1);
});

it("reports never-used items as zero", async () => {
  app = createTestApp();
  const item = await addItem(app.services.library, "asset", "Untouched");
  expect(app.services.library.get(item.id)?.stats).toEqual({
    timesUsed: 0,
    slideshowCount: 0,
    firstUsedAt: null,
    lastUsedAt: null,
  });
});

it("sorts least-used first so an agent can vary its choices", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const heavy = await addItem(library, "asset", "Heavy");
  const light = await addItem(library, "asset", "Light");
  const never = await addItem(library, "asset", "Never");

  projects.create({
    accountId: "default",
    name: "One",
    document: document([slide(background.id, [heavy.id, heavy.id, heavy.id, light.id])]),
  });

  expect(
    library.list({ kind: "asset", sort: "least-used" }).items.map((item) => item.name),
  ).toEqual(["Never", "Light", "Heavy"]);
  expect(
    library.list({ kind: "asset", sort: "most-used" }).items.map((item) => item.name),
  ).toEqual(["Heavy", "Light", "Never"]);
  expect(library.get(never.id)?.stats.timesUsed).toBe(0);
});

it("applies a sort to search results too", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const heavy = await addItem(library, "asset", "Arrow one", { description: "an arrow" });
  await addItem(library, "asset", "Arrow two", { description: "an arrow" });
  projects.create({
    accountId: "default",
    name: "One",
    document: document([slide(background.id, [heavy.id])]),
  });

  const names = library
    .list({ kind: "asset", query: "arrow", sort: "least-used" })
    .items.map((item) => item.name);
  expect(names).toEqual(["Arrow two", "Arrow one"]);
});
