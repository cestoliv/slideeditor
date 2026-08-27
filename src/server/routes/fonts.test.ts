import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

it("lists the seeded builtin catalogue", async () => {
  const response = await app.inject({ method: "GET", url: "/api/fonts" });
  expect(response.statusCode).toBe(200);
  const families = response.json().fonts.map((font: { family: string }) => font.family);
  expect(families).toContain("TikTok Sans");
  expect(families).toContain("Space Mono");
});

it("rejects an empty family on POST /api/fonts", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/fonts",
    payload: { family: "  " },
  });
  expect(response.statusCode).toBe(400);
});

/*
 * A deleted builtin does not stay deleted: FontService reseeds anything
 * missing on its next construction (a server restart), so a 200 here would
 * describe a delete that silently reverts. Refusing is what the service
 * layer actually does (fonts.test.ts covers the reasoning); this just proves
 * the route carries the refusal through rather than swallowing it.
 */
it("refuses to delete a builtin font over the route", async () => {
  const list = await app.inject({ method: "GET", url: "/api/fonts" });
  const font = list
    .json()
    .fonts.find((f: { family: string }) => f.family === "Space Mono");
  expect(font).toBeDefined();

  const response = await app.inject({ method: "DELETE", url: `/api/fonts/${font.id}` });
  expect(response.statusCode).toBe(400);

  const stillThere = await app.inject({ method: "GET", url: "/api/fonts" });
  expect(stillThere.json().fonts.some((f: { id: string }) => f.id === font.id)).toBe(
    true,
  );
});

it("deletes an unused google font and then 404s deleting it again", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("fonts.googleapis.com")) {
      return new Response(
        "@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:500;" +
          "src:url(https://fonts.gstatic.com/s/stub/v1/stub.woff2) format('woff2');}",
        { status: 200 },
      );
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });
  }) as typeof fetch;

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/fonts",
      payload: { family: "Space Grotesk" },
    });
    expect(created.statusCode).toBe(200);
    const font = created.json().font as { id: string };

    const first = await app.inject({ method: "DELETE", url: `/api/fonts/${font.id}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ removed: font.id });

    const second = await app.inject({ method: "DELETE", url: `/api/fonts/${font.id}` });
    expect(second.statusCode).toBe(404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("serves a builtin font file with the right content type", async () => {
  const response = await app.inject({ method: "GET", url: "/fonts/tiktok-sans.ttf" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("font/ttf");
});

it("serves the exact url list() computed for a builtin family, not a hardcoded guess", async () => {
  const list = await app.inject({ method: "GET", url: "/api/fonts" });
  const font = list
    .json()
    .fonts.find((f: { family: string }) => f.family === "TikTok Sans");
  expect(font).toBeDefined();
  expect(font.url).toBe("/fonts/tiktok-sans.ttf");

  const served = await app.inject({ method: "GET", url: font.url });
  expect(served.statusCode).toBe(200);
});

it("404s a font file it does not have", async () => {
  const response = await app.inject({ method: "GET", url: "/fonts/not-a-font.ttf" });
  expect(response.statusCode).toBe(404);
});

// The name is not content-addressed (services/fonts.ts's builtinFontFileName
// derives it from the family, not the bytes), so a future release shipping
// different bytes under the same path must not leave a browser holding an
// `immutable` promise about them for a year.
it("does not claim the builtin file is immutable", async () => {
  const response = await app.inject({ method: "GET", url: "/fonts/tiktok-sans.ttf" });
  expect(response.headers["cache-control"]).not.toContain("immutable");
  expect(response.headers.etag).toBeTruthy();
});

it("answers a matching If-None-Match with 304", async () => {
  const first = await app.inject({ method: "GET", url: "/fonts/tiktok-sans.ttf" });
  const etag = first.headers.etag;
  expect(etag).toBeTruthy();
  const second = await app.inject({
    method: "GET",
    url: "/fonts/tiktok-sans.ttf",
    headers: { "if-none-match": String(etag) },
  });
  expect(second.statusCode).toBe(304);
});

// TikTokSans.ttf is only ever bundled as .ttf; a URL naming an extension it
// does not actually have must not serve the bytes under the wrong
// Content-Type.
it("404s a builtin slug requested with the wrong extension", async () => {
  const response = await app.inject({ method: "GET", url: "/fonts/tiktok-sans.woff2" });
  expect(response.statusCode).toBe(404);
});
