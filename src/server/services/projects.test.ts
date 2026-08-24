import { afterEach, expect, it, vi } from "vitest";
import {
  asHttpError,
  catchError,
  createTestApp,
  addItem,
  type TestApp,
} from "../testing.js";
import { ProjectService, type StoredProject } from "./projects.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

interface SlideDocument {
  ratio: { w: number; h: number };
  slides: {
    id: string;
    backgroundItemId: string | null;
    texts: unknown[];
    overlays: { id: string; itemId: string }[];
  }[];
}

function slideDocument(backgroundId: string, itemId: string | null): SlideDocument {
  return {
    ratio: { w: 9, h: 16 },
    slides: [
      {
        id: "s1",
        backgroundItemId: backgroundId,
        texts: [],
        overlays: itemId ? [{ id: "o1", itemId }] : [],
      },
    ],
  };
}

it("increments the version on every write", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "One" });
  expect(project.version).toBe(1);
  expect(
    projects.save(project.id, { name: "One", document: project, version: 1 }).version,
  ).toBe(2);
  expect(
    projects.save(project.id, { name: "One", document: project, version: 2 }).version,
  ).toBe(3);
});

it("rejects a stale write and reports the current state", async () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Guarded" });
  projects.save(project.id, { name: "Guarded", document: project, version: 1 });

  const error = asHttpError(
    await catchError(() =>
      projects.save(project.id, { name: "Loser", document: project, version: 1 }),
    ),
  );
  expect(error.status).toBe(409);
  const details = error.details as { currentVersion: number };
  expect(details.currentVersion).toBe(2);
  expect(projects.get(project.id)?.name, "the stale write must not land").toBe("Guarded");
});

it("tracks which slideshows use which library items", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As");
  const other = await addItem(library, "asset", "Unused");

  const project = projects.create({
    name: "Tracked",
    document: slideDocument(background.id, asset.id),
  });
  expect(library.usedBy(background.id).map((project) => project.name)).toEqual([
    "Tracked",
  ]);
  expect(library.usedBy(asset.id).map((project) => project.name)).toEqual(["Tracked"]);
  expect(library.usedBy(other.id)).toEqual([]);

  // Dropping the overlay must drop the usage record with it.
  projects.save(project.id, {
    name: "Tracked",
    document: slideDocument(background.id, null),
    version: project.version,
  });
  expect(library.usedBy(asset.id)).toEqual([]);
  expect(library.usedBy(background.id).map((project) => project.name)).toEqual([
    "Tracked",
  ]);
});

it("clears usage when a slideshow is deleted", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const project = projects.create({
    name: "Doomed",
    document: slideDocument(background.id, null),
  });
  projects.remove(project.id);
  expect(library.usedBy(background.id)).toEqual([]);
  expect(projects.get(project.id)).toBeNull();
});

it("falls back to the default ratio for nonsense input", () => {
  app = createTestApp();
  const project = app.services.projects.create({
    name: "Odd",
    document: { ratio: { w: 0, h: -3 }, slides: [] },
  });
  expect(project.ratio).toEqual({ w: 9, h: 16 });
});

it("reports a missing slideshow as 404", async () => {
  app = createTestApp();
  const { projects } = app.services;
  const error = asHttpError(await catchError(() => projects.require("nope")));
  expect(error.status).toBe(404);
});

it("summaries carry the cover and slide count without the document", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Cover");
  projects.create({ name: "Listed", document: slideDocument(background.id, null) });
  const [summary] = projects.list();
  expect(summary?.slideCount).toBe(1);
  expect(summary?.coverUrl).toBe(background.url);
  expect(summary && "document" in summary).toBe(false);
});

// ---------------------------------------------------------------------------
// New with the port.

it("serialises a summary in the order the HTTP API has always used", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Cover");
  projects.create({ name: "Listed", document: slideDocument(background.id, null) });
  const [summary] = projects.list();

  // coverUrl is last because list() appends it after toSummary, exactly as
  // server/projects.mjs:23-25 did. It crosses the wire in this order.
  expect(summary && Object.keys(summary)).toEqual([
    "id",
    "name",
    "version",
    "ratio",
    "status",
    "description",
    "hashtags",
    "slideCount",
    "coverItemId",
    "createdAt",
    "updatedAt",
    "coverUrl",
  ]);
});

it("keeps the first use while the last use moves", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As", { width: 400, height: 300 });

  // A forced clock, because two saves in the same millisecond cannot tell a
  // preserved first_used_at from an overwritten one.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_700_000_000_000);
    const project = projects.create({
      name: "Twice",
      document: {
        ratio: { w: 9, h: 16 },
        slides: [
          { id: "s1", backgroundItemId: background.id, overlays: [{ itemId: asset.id }] },
        ],
      },
    });
    const first = library.get(asset.id)?.stats;
    expect(first?.firstUsedAt, "the first save records both timestamps").toBe(
      1_700_000_000_000,
    );
    expect(first?.lastUsedAt).toBe(1_700_000_000_000);

    vi.setSystemTime(1_700_000_060_000);
    projects.save(project.id, {
      document: {
        ratio: { w: 9, h: 16 },
        slides: [
          {
            id: "s1",
            backgroundItemId: background.id,
            overlays: [{ itemId: asset.id }, { itemId: asset.id }],
          },
        ],
      },
      version: project.version,
    });

    const second = library.get(asset.id)?.stats;
    expect(second?.firstUsedAt, "a re-save must not move the first use").toBe(
      1_700_000_000_000,
    );
    expect(second?.lastUsedAt, "but it does move the last use").toBe(1_700_000_060_000);
    expect(second?.timesUsed, "and it replaces the placement count").toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("truncates a slideshow name at 200 characters", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "n".repeat(300) });
  expect(project.name.length).toBe(200);
  const saved = projects.save(project.id, {
    name: "s".repeat(300),
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: project.version,
  });
  expect(saved.name.length).toBe(200);
});

it("starts a new slideshow at version 1 and status draft", () => {
  app = createTestApp();
  const project = app.services.projects.create();
  expect(project.version).toBe(1);
  expect(project.status).toBe("draft");
  expect(project.name, "the default name").toBe("New Project");
  expect(project.ratio).toEqual({ w: 9, h: 16 });
  expect(project.slides).toEqual([]);
});

it("rejects a save carrying a stale version with 409 and the current project", async () => {
  app = createTestApp();
  const { projects } = app.services;
  const created = projects.create({ name: "Held" });
  const saved = projects.save(created.id, {
    name: "Held",
    document: created,
    version: 1,
  });

  const error = asHttpError(
    await catchError(() =>
      projects.save(created.id, { name: "Stale", document: created, version: 1 }),
    ),
  );
  expect(error.status).toBe(409);
  expect(error.message).toBe("This slideshow changed since you loaded it.");
  const details = error.details as { currentVersion: number; project: StoredProject };
  expect(details.currentVersion).toBe(2);
  expect(details.project, "the loser gets the winning state back").toEqual(saved);
});

it("bumps the version on every accepted save", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Counting" });
  let version = project.version;
  for (let round = 0; round < 5; round += 1) {
    const next = projects.save(project.id, {
      document: { ratio: { w: 1, h: 1 }, slides: [] },
      version,
    });
    expect(next.version).toBe(version + 1);
    version = next.version;
  }
  expect(projects.get(project.id)?.version).toBe(6);
});

it("keeps the name when a save leaves it out", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Named" });
  const saved = projects.save(project.id, {
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: 1,
  });
  expect(saved.name).toBe("Named");
});

it("keeps a slide field the rewrite does not model", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const slides = [
    { id: "s1", backgroundItemId: background.id, futureField: { nested: true } },
  ];
  const project = projects.create({
    name: "Forward",
    document: { ratio: { w: 9, h: 16 }, slides },
  });
  expect(
    projects.get(project.id)?.slides,
    "a save must not drop what it cannot name",
  ).toEqual(slides);
});

it("counts one placement per overlay and one for the background", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const asset = await addItem(library, "asset", "As", { width: 400, height: 300 });
  projects.create({
    name: "Counted",
    document: {
      ratio: { w: 9, h: 16 },
      slides: [
        {
          id: "s1",
          backgroundItemId: background.id,
          overlays: [{ itemId: asset.id }, { itemId: asset.id }],
        },
        { id: "s2", backgroundItemId: background.id, overlays: [{ itemId: asset.id }] },
      ],
    },
  });
  expect(library.get(asset.id)?.stats.timesUsed).toBe(3);
  expect(library.get(background.id)?.stats.timesUsed, "once per slide it backs").toBe(2);
});

it("keeps usage history after the slideshow is deleted", async () => {
  app = createTestApp();
  const { library, projects } = app.services;
  const background = await addItem(library, "background", "Bg");
  const project = projects.create({
    name: "Doomed",
    document: slideDocument(background.id, null),
  });
  const before = library.get(background.id)?.stats;
  projects.remove(project.id);

  expect(library.get(background.id)?.stats, "history outlives the slideshow").toEqual(
    before,
  );
  expect(library.usedBy(background.id), "the live index still clears").toEqual([]);
});

it("announces every change on the event stream", () => {
  app = createTestApp();
  const seen: unknown[] = [];
  app.events.broadcast = (payload) => {
    seen.push(payload);
  };
  const { projects } = app.services;
  const project = projects.create({ name: "Watched" });
  projects.save(project.id, {
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: 1,
  });
  projects.remove(project.id);

  expect(seen).toEqual([
    { type: "project.changed", projectId: project.id, version: 1 },
    { type: "project.changed", projectId: project.id, version: 2 },
    { type: "project.removed", projectId: project.id },
  ]);
});

it("works without an event bus or a library", () => {
  app = createTestApp();
  const projects = new ProjectService(app.db, null);
  const project = projects.create({ name: "Alone" });
  expect(projects.list().map((summary) => summary.name)).toEqual(["Alone"]);
  expect(projects.list()[0]?.coverUrl, "no library means no cover to look up").toBeNull();
  expect(projects.get(project.id)?.name).toBe("Alone");
});

// ---------------------------------------------------------------------------
// The caption: the description a slideshow is posted with, and its hashtags.

it("stores a caption and hands it back in the shape everything reads", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({
    name: "Captioned",
    description: "Five things to know first",
    hashtags: ["travel", "#summer"],
  });

  expect(project.description).toBe("Five things to know first");
  expect(project.hashtags, "a list arrives as the one string form").toBe(
    "#travel #summer",
  );
  expect(projects.get(project.id)?.hashtags).toBe("#travel #summer");
  expect(projects.list()[0]?.description).toBe("Five things to know first");
  expect(projects.list()[0]?.hashtags).toBe("#travel #summer");
});

it("starts a slideshow with no caption when none was asked for", () => {
  app = createTestApp();
  const project = app.services.projects.create({ name: "Bare" });
  expect(project.description).toBe("");
  expect(project.hashtags).toBe("");
});

it("leaves a caption alone when a save says nothing about it", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({
    name: "Captioned",
    description: "Written by the agent",
    hashtags: "#travel",
  });

  // The save every editor built before this feature sends: a document, a name
  // and a version, and not a word about the caption.
  const saved = projects.save(project.id, {
    name: "Captioned",
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: 1,
  });

  expect(saved.description, "an unrelated save must not wipe the caption").toBe(
    "Written by the agent",
  );
  expect(saved.hashtags).toBe("#travel");
});

it("clears a caption for a save that asks for it in as many words", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({
    name: "Captioned",
    description: "Written by the agent",
    hashtags: "#travel",
  });
  const saved = projects.save(project.id, {
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: 1,
    description: "",
    hashtags: "",
  });

  expect(saved.description).toBe("");
  expect(saved.hashtags).toBe("");
});

it("normalises the hashtags a save carries", () => {
  app = createTestApp();
  const { projects } = app.services;
  const project = projects.create({ name: "Captioned" });
  const saved = projects.save(project.id, {
    document: { ratio: { w: 9, h: 16 }, slides: [] },
    version: 1,
    hashtags: "travel, #Travel summer",
  });

  expect(saved.hashtags).toBe("#travel #summer");
});
