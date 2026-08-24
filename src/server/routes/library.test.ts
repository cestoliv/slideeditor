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

async function createItem(kind = "background", name = "Beach"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { kind, name, contentType: "image/png", data: pngFixture(64, 64) },
  });
  expect(response.statusCode).toBe(200);
  return String(response.json().item.id);
}

it("creates a library item from base64 data", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: {
      kind: "background",
      name: "Beach",
      contentType: "image/png",
      data: pngFixture(64, 64),
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().item).toMatchObject({
    kind: "background",
    name: "Beach",
    width: 64,
    height: 64,
  });
});

it("accepts a data URL as well as bare base64", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: {
      kind: "asset",
      name: "Sticker",
      contentType: "image/png",
      data: `data:image/png;base64,${pngFixture(32, 48)}`,
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().item).toMatchObject({ kind: "asset", width: 32, height: 48 });
});

it("keeps the messages an agent reads when the upload is unusable", async () => {
  const missing = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { kind: "background" },
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error).toBe("The upload needs a base64 `data` field.");

  const empty = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { data: "!!!!" },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error).toBe("The upload data was not valid base64.");

  const kind = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { kind: "sticker", contentType: "image/png", data: pngFixture(8, 8) },
  });
  expect(kind.statusCode).toBe(400);
  expect(kind.json().error).toBe("Unknown kind: sticker");
});

it("reads one item back with the slideshows that use it", async () => {
  const id = await createItem();
  const response = await app.inject({ method: "GET", url: `/api/library/${id}` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ item: { id }, usedBy: [] });
});

it("answers 404 for an item that is not there", async () => {
  const response = await app.inject({ method: "GET", url: "/api/library/nope" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("No library item with id nope");
});

it("lists items with a total, and filters by kind", async () => {
  await createItem("background", "Beach");
  await createItem("asset", "Arrow");
  await createItem("asset", "Star");
  const all = await app.inject({ method: "GET", url: "/api/library" });
  expect(all.json().total).toBe(3);
  expect(all.json().items).toHaveLength(3);

  const assets = await app.inject({ method: "GET", url: "/api/library?kind=asset" });
  // Two items written in the same millisecond tie on updated_at, so the order
  // between them is SQLite's to choose and this asserts the set.
  expect(
    assets
      .json()
      .items.map((item: { name: string }) => item.name)
      .sort(),
  ).toEqual(["Arrow", "Star"]);
  expect(assets.json().total).toBe(2);
});

it("pages through the list with limit and offset", async () => {
  await createItem("background", "One");
  await createItem("background", "Two");
  await createItem("background", "Three");

  const first = await app.inject({ method: "GET", url: "/api/library?limit=1" });
  expect(first.json().items).toHaveLength(1);
  // The total counts the whole library, not the page.
  expect(first.json().total).toBe(3);

  const second = await app.inject({
    method: "GET",
    url: "/api/library?limit=1&offset=1",
  });
  expect(second.json().items).toHaveLength(1);
  // Three items written in the same millisecond tie on updated_at, so which one
  // lands on which page is SQLite's to choose. The pages still differ.
  expect(second.json().items[0].id).not.toBe(first.json().items[0].id);

  // A limit that is not a number falls back to the default rather than failing.
  const junk = await app.inject({ method: "GET", url: "/api/library?limit=soon" });
  expect(junk.json().items).toHaveLength(3);
});

it("honours a sort it knows and ignores one it does not", async () => {
  // The order clause is interpolated into the SQL rather than bound, so this is
  // the one value on the read path that must never reach it unchecked.
  const used = await createItem("background", "Used");
  const unused = await createItem("background", "Unused");
  await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { name: "Trip", slides: [{ background: used }] },
  });

  const names = (response: { json(): { items: { id: string }[] } }) =>
    response.json().items.map((item) => item.id);

  expect(
    names(await app.inject({ method: "GET", url: "/api/library?sort=least-used" })),
  ).toEqual([unused, used]);
  expect(
    names(await app.inject({ method: "GET", url: "/api/library?sort=most-used" })),
  ).toEqual([used, unused]);

  const junk = await app.inject({ method: "GET", url: "/api/library?sort=nonsense" });
  expect(junk.statusCode).toBe(200);
  expect(names(junk)).toHaveLength(2);
});

it("keeps SQL in a sort parameter out of the order clause", async () => {
  // This asserts the parameter never reaches the clause. It is not a test of
  // injection resistance: node:sqlite prepares one statement, so the trailing
  // DROP could not have fired even if the guard let it through.
  await createItem("background", "Beach");
  const injected = "recent; DROP TABLE library_item--";
  const response = await app.inject({
    method: "GET",
    url: `/api/library?sort=${encodeURIComponent(injected)}`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().items).toHaveLength(1);

  // The table is still there, which a dropped one would not be.
  const after = await app.inject({ method: "GET", url: "/api/library" });
  expect(after.statusCode).toBe(200);
  expect(after.json().total).toBe(1);
});

it("rejects an unknown kind filter with 400", async () => {
  const response = await app.inject({ method: "GET", url: "/api/library?kind=sticker" });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("Unknown kind: sticker");
});

it("patches the fields it is given and leaves the rest alone", async () => {
  const id = await createItem("background", "Beach");
  const response = await app.inject({
    method: "PATCH",
    url: `/api/library/${id}`,
    payload: { name: "Sunset", tags: "warm, dusk" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().item).toMatchObject({
    name: "Sunset",
    tags: ["warm", "dusk"],
    kind: "background",
  });
});

it("returns 409 with usedBy when deleting an item in use", async () => {
  const id = await createItem();
  const slideshow = await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { name: "Trip", slides: [{ background: id, texts: ["Hello"] }] },
  });
  expect(slideshow.statusCode).toBe(200);

  const response = await app.inject({ method: "DELETE", url: `/api/library/${id}` });
  expect(response.statusCode).toBe(409);
  expect(response.json().usedBy).toHaveLength(1);
  expect(response.json().usedBy[0]).toMatchObject({ name: "Trip" });
  expect(response.json().error).toBe("Beach is used by 1 slideshow.");
});

it("deletes an item in use when force is 1", async () => {
  const id = await createItem();
  await app.inject({
    method: "POST",
    url: "/api/slideshows",
    payload: { name: "Trip", slides: [{ background: id }] },
  });
  const response = await app.inject({
    method: "DELETE",
    url: `/api/library/${id}?force=1`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    removed: id,
    brokeSlideshows: [{ name: "Trip" }],
  });
  expect(
    (await app.inject({ method: "GET", url: `/api/library/${id}` })).statusCode,
  ).toBe(404);
});

it("returns 405 for a method the path does not accept", async () => {
  const response = await app.inject({ method: "DELETE", url: "/api/health" });
  expect(response.statusCode).toBe(405);
  expect(response.json().error).toBe("DELETE is not allowed here.");
});

it("returns 404 for an unknown API path", async () => {
  const response = await app.inject({ method: "GET", url: "/api/nope" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toContain("/api/nope");
});

it("sends every JSON reply with the headers sendJson set", async () => {
  const ok = await app.inject({ method: "GET", url: "/api/health" });
  expect(ok.headers["cache-control"]).toBe("no-store");
  expect(ok.headers["x-content-type-options"]).toBe("nosniff");

  const missing = await app.inject({ method: "GET", url: "/api/library/nope" });
  expect(missing.headers["cache-control"]).toBe("no-store");
  expect(missing.headers["x-content-type-options"]).toBe("nosniff");
});

it("reads a body an agent sent with no content type", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify({
      kind: "asset",
      name: "Arrow",
      contentType: "image/png",
      data: pngFixture(16, 16),
    }),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().item.name).toBe("Arrow");
});

it("answers a malformed body with the old message", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    headers: { "content-type": "application/json" },
    payload: "{ not json",
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("The request body is not valid JSON.");
});
