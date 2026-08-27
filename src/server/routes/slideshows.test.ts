import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp, pngFixture } from "../testing.js";
import { BUILTIN_DEFAULTS } from "../../shared/schema/index.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

async function addItem(
  kind: "background" | "asset",
  name: string,
  accountId = "default",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: {
      kind,
      name,
      contentType: "image/png",
      data: pngFixture(120, 160),
      accountId,
    },
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
  const response = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { accountId: "default", ...payload },
  });
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
      accountId: "default",
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
    payload: { accountId: "default", slides: [] },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error).toBe("A slideshow needs at least one slide.");

  const noBackground = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { accountId: "default", slides: [{}] },
  });
  expect(noBackground.statusCode).toBe(400);
  expect(noBackground.json().error).toBe("Slide 1 needs a background library item id.");
});

it("reports the unknown account rather than a cross-account item error", async () => {
  const background = await addItem("background", "Beach");
  const response = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { accountId: "does-not-exist", slides: [{ background }] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("No account with id does-not-exist.");
});

it("rejects a background that is really an asset, with the library's message", async () => {
  const asset = await addItem("asset", "Arrow");
  const response = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { slides: [{ background: asset }], accountId: "default" },
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

it("filters the listing to one account with ?account=", async () => {
  const account = app.accounts.create({
    name: "Side project",
    defaults: BUILTIN_DEFAULTS,
  });
  const ownBackground = await addItem("background", "Beach", "default");
  const otherBackground = await addItem("background", "Dawn", account.id);
  const own = await createSlideshow({
    name: "Default's",
    slides: [{ background: ownBackground }],
  });
  const other = await createSlideshow({
    name: "Side project's",
    accountId: account.id,
    slides: [{ background: otherBackground }],
  });

  const filtered = await app.inject({
    method: "GET",
    url: `/api/slideshows?account=${account.id}`,
  });
  expect(
    filtered.json().slideshows.map((slideshow: { id: string }) => slideshow.id),
  ).toEqual([other.id]);

  const unfiltered = await app.inject({ method: "GET", url: "/api/slideshows" });
  expect(
    unfiltered
      .json()
      .slideshows.map((slideshow: { id: string }) => slideshow.id)
      .sort(),
  ).toEqual([own.id, other.id].sort());
});

// No account has "" as its id, so an empty ?account= must narrow the result
// to nothing rather than being treated as "no filter" and widening back out
// to every account's rows.
it("narrows to nothing rather than every account on an empty ?account=", async () => {
  const background = await addItem("background", "Beach");
  await createSlideshow({ slides: [{ background }] });

  const filtered = await app.inject({ method: "GET", url: "/api/slideshows?account=" });
  expect(filtered.json().slideshows).toEqual([]);
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
    accountId: "default",
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
      accountId: "default",
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

it("seeds a new slideshow's ratio from its account's default when none is given", async () => {
  const account = app.accounts.create({
    name: "Instagram",
    defaults: { ...BUILTIN_DEFAULTS, ratio: { w: 3, h: 4 } },
  });
  const background = await addItem("background", "Beach", account.id);
  const created = await createSlideshow({
    accountId: account.id,
    slides: [{ background }],
  });
  const read = await app.inject({ method: "GET", url: `/api/slideshows/${created.id}` });
  expect(read.json().slideshow.ratio).toEqual({ w: 3, h: 4 });
});

/*
 * Finding 10: layoutTexts' line-wrap estimate used to know only two families
 * by name (shared/text/constants.ts's FONT_ADVANCE_RATIO), so an account on
 * any OTHER family — including the second builtin itself, read through this
 * route rather than the hardcoded map directly — got whichever of the two
 * happened to be the shared default. FontService now carries each builtin's
 * own measured advance in the font table (services/fonts.ts's
 * advanceRatioFor), threaded through this route's composeDocument call. The
 * two builtins have different advances (0.5 vs 0.6, seedBuiltins), so the
 * exact same long caption at the same size must wrap to a taller block for
 * the wider-average-glyph family — proof the route reads the real per-family
 * value FontService supplies rather than always falling through to one
 * shared constant.
 */
it("wraps the same caption to a different height for a different builtin family", async () => {
  const long = "word ".repeat(40).trim();
  const tiktok = app.accounts.create({
    name: "TikTok Sans account",
    defaults: BUILTIN_DEFAULTS,
  });
  const spaceMono = app.accounts.create({
    name: "Space Mono account",
    defaults: {
      ...BUILTIN_DEFAULTS,
      text: { ...BUILTIN_DEFAULTS.text, fontFamily: "Space Mono" },
    },
  });
  const tiktokBg = await addItem("background", "Bg", tiktok.id);
  const spaceMonoBg = await addItem("background", "Bg", spaceMono.id);

  const tiktokShow = await createSlideshow({
    accountId: tiktok.id,
    slides: [{ background: tiktokBg, texts: [long] }],
  });
  const spaceMonoShow = await createSlideshow({
    accountId: spaceMono.id,
    slides: [{ background: spaceMonoBg, texts: [long] }],
  });

  const tiktokRead = await app.inject({
    method: "GET",
    url: `/api/projects/${tiktokShow.id}`,
  });
  const spaceMonoRead = await app.inject({
    method: "GET",
    url: `/api/projects/${spaceMonoShow.id}`,
  });
  const tiktokHeight = tiktokRead.json().project.slides[0].texts[0].height as number;
  const spaceMonoHeight = spaceMonoRead.json().project.slides[0].texts[0]
    .height as number;
  // Space Mono's wider average glyph (0.6 vs TikTok Sans's 0.5) fits fewer
  // characters per line, so the same string wraps to more lines and a taller
  // block.
  expect(spaceMonoHeight).toBeGreaterThan(tiktokHeight);
});

it("keeps an explicit ratio even when the account default differs", async () => {
  const account = app.accounts.create({
    name: "Instagram",
    defaults: { ...BUILTIN_DEFAULTS, ratio: { w: 3, h: 4 } },
  });
  const background = await addItem("background", "Beach", account.id);
  const created = await createSlideshow({
    accountId: account.id,
    ratio: { w: 1, h: 1 },
    slides: [{ background }],
  });
  const read = await app.inject({ method: "GET", url: `/api/slideshows/${created.id}` });
  expect(read.json().slideshow.ratio).toEqual({ w: 1, h: 1 });
});
