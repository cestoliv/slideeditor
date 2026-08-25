import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp, pngFixture } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

async function addItem(kind: "background" | "asset", name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { kind, name, contentType: "image/png", data: pngFixture(120, 160) },
  });
  expect(response.statusCode).toBe(200);
  return String(response.json().item.id);
}

interface SlideshowWrite {
  id: string;
  version: number;
  editUrl: string;
  slideCount: number;
}

async function createSlideshow(
  payload: Record<string, unknown>,
): Promise<SlideshowWrite> {
  const response = await app.inject({ method: "POST", url: "/api/slideshows", payload });
  expect(response.statusCode).toBe(200);
  return response.json() as SlideshowWrite;
}

it("returns an edit URL a browser can open", async () => {
  const background = await addItem("background", "Beach");
  const response = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: {
      name: "Trip",
      ratio: { w: 4, h: 5 },
      slides: [{ background, texts: ["Hello"] }],
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().editUrl).toMatch(/\/projects\/[0-9a-f-]+$/);
  expect(response.json().slideCount).toBe(1);
  expect(response.json().version).toBe(1);
});

it("names an unnamed slideshow the way the old server did", async () => {
  const background = await addItem("background", "Beach");
  const created = await createSlideshow({ slides: [{ background }] });
  const read = await app.inject({ method: "GET", url: `/api/slideshows/${created.id}` });
  expect(read.json().slideshow.name).toBe("Agent slideshow");
});

it("rejects a composition the engine will not take, with a 400", async () => {
  const empty = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { slides: [] },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error).toBe("A slideshow needs at least one slide.");

  const noBackground = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { slides: [{}] },
  });
  expect(noBackground.statusCode).toBe(400);
  expect(noBackground.json().error).toBe("Slide 1 needs a background library item id.");
});

it("rejects a background that is really an asset, with the library's message", async () => {
  const asset = await addItem("asset", "Arrow");
  const response = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { slides: [{ background: asset }] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("is an asset, expected a background");
});

it("hides published slideshows from the default list", async () => {
  const background = await addItem("background", "Beach");
  const open = await createSlideshow({ name: "Open", slides: [{ background }] });
  const done = await createSlideshow({ name: "Done", slides: [{ background }] });
  const status = await app.inject({
    method: "PATCH",
    url: `/api/slideshows/${done.id}/status`,
    payload: { status: "published" },
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ id: done.id, status: "published" });
  expect(status.json().editUrl).toContain(`/projects/${done.id}`);

  const listed = await app.inject({ method: "GET", url: "/api/slideshows" });
  expect(
    listed.json().slideshows.map((slideshow: { id: string }) => slideshow.id),
  ).toEqual([open.id]);
  expect(listed.json().slideshows[0].editUrl).toContain(`/projects/${open.id}`);

  const all = await app.inject({ method: "GET", url: "/api/slideshows?status=all" });
  expect(all.json().slideshows).toHaveLength(2);
});

it("reduces a slideshow back to its composition on read", async () => {
  const background = await addItem("background", "Beach");
  const first = await addItem("asset", "Arrow");
  const second = await addItem("asset", "Star");
  const created = await createSlideshow({
    name: "Trip",
    slides: [
      { name: "Opener", background, assets: [first, second], texts: ["One", "Two"] },
    ],
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/slideshows/${created.id}`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().slideshow).toMatchObject({
    id: created.id,
    name: "Trip",
    version: 1,
    status: "draft",
  });
  expect(response.json().slideshow.slides).toEqual([
    { name: "Opener", background, assets: [first, second], texts: ["One", "Two"] },
  ]);
  expect(response.json().editUrl).toContain(`/projects/${created.id}`);
});

it("preserves the human's layout on an update that changes one slide", async () => {
  const background = await addItem("background", "Beach");
  const created = await createSlideshow({
    name: "Trip",
    slides: [
      { background, texts: ["One"] },
      { background, texts: ["Two"] },
    ],
  });

  // The human drags the first slide's text somewhere else and saves.
  const read = await app.inject({ method: "GET", url: `/api/projects/${created.id}` });
  const document = read.json().project;
  document.slides[0].texts[0].x = 0.42;
  const saved = await app.inject({
    method: "PUT",
    url: `/api/projects/${created.id}`,
    payload: { document, version: document.version },
  });
  expect(saved.statusCode).toBe(200);

  // The agent rewrites the second slide only.
  const updated = await app.inject({
    method: "PUT",
    url: `/api/slideshows/${created.id}`,
    payload: {
      version: saved.json().project.version,
      slides: [
        { background, texts: ["One"] },
        { background, texts: ["Changed"] },
      ],
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().slideCount).toBe(2);

  const after = await app.inject({ method: "GET", url: `/api/projects/${created.id}` });
  expect(after.json().project.slides[0].texts[0].x).toBe(0.42);
  expect(after.json().project.slides[0].id).toBe(document.slides[0].id);
  expect(after.json().project.slides[1].texts[0].text).toBe("Changed");
});

it("takes the current version when an update sends none", async () => {
  const background = await addItem("background", "Beach");
  const created = await createSlideshow({ name: "Trip", slides: [{ background }] });
  const response = await app.inject({
    method: "PUT",
    url: `/api/slideshows/${created.id}`,
    payload: { slides: [{ background, texts: ["New"] }] },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().version).toBe(2);
});

it("answers a stale slideshow update with the 409 the editor reads", async () => {
  const background = await addItem("background", "Beach");
  const created = await createSlideshow({ name: "Trip", slides: [{ background }] });
  const response = await app.inject({
    method: "PUT",
    url: `/api/slideshows/${created.id}`,
    payload: { version: 99, slides: [{ background }] },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ currentVersion: 1 });
  expect(response.json().project.id).toBe(created.id);
});

it("answers 404 for a slideshow that is not there", async () => {
  const response = await app.inject({ method: "GET", url: "/api/slideshows/nope" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("No slideshow with id nope");
});

it("takes a caption from an agent and reads it back on the slideshow", async () => {
  const background = await addItem("background", "Beach");
  const created = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: {
      name: "Trip",
      slides: [{ background }],
      description: "Five things to know first",
      hashtags: ["travel", "#summer"],
    },
  });
  expect(created.statusCode).toBe(200);
  // Echoed on the write, so a caller learns what its list of tags became
  // without reading the slideshow back.
  expect(created.json().description).toBe("Five things to know first");
  expect(created.json().hashtags).toBe("#travel #summer");

  const read = await app.inject({
    method: "GET",
    url: `/api/slideshows/${String(created.json().id)}`,
  });
  expect(read.json().slideshow.description).toBe("Five things to know first");
  expect(read.json().slideshow.hashtags).toBe("#travel #summer");
});

it("keeps the caption through an update that only changes the slides", async () => {
  const background = await addItem("background", "Beach");
  const created = await createSlideshow({
    name: "Trip",
    slides: [{ background }],
    description: "Written first",
    hashtags: "#travel",
  });
  const updated = await app.inject({
    method: "PUT",
    url: `/api/slideshows/${created.id}`,
    payload: { version: created.version, slides: [{ background, texts: ["New"] }] },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().description).toBe("Written first");
  expect(updated.json().hashtags).toBe("#travel");
});
