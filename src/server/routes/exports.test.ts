import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp, solidPng } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

/**
 * Files two slides straight through the service, the way the upload route does.
 *
 * The render rows reference project(id), so the slideshow has to be a real one.
 */
async function fileTwoRenders(): Promise<{
  id: string;
  token: string;
  bytes: number;
}> {
  const { id } = app.projects.create({ accountId: "default" });
  const png = solidPng(40, 60);
  const mediaId = await app.media.put(png, "png");
  for (const index of [0, 1]) {
    app.exports.putRender(id, 3, index, {
      mediaId,
      width: 40,
      height: 60,
      bytes: png.byteLength,
    });
  }
  return { id, token: app.exports.grant(id, 3).token, bytes: png.byteLength };
}

it("serves a slide to a caller with no credential at all", async () => {
  const { token, bytes } = await fileTwoRenders();
  const response = await app.inject({ method: "GET", url: `/export/${token}/01.png` });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  expect(response.rawPayload.byteLength).toBe(bytes);
});

it("tells crawlers and caches to keep the link to themselves", async () => {
  const { token } = await fileTwoRenders();
  const response = await app.inject({ method: "GET", url: `/export/${token}/01.png` });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
});

it("serves each index as its own slide", async () => {
  const { token } = await fileTwoRenders();
  expect(
    (await app.inject({ method: "GET", url: `/export/${token}/02.png` })).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: "GET", url: `/export/${token}/03.png` })).statusCode,
  ).toBe(404);
});

it("says nothing about a token it does not know", async () => {
  const response = await app.inject({ method: "GET", url: "/export/nope/01.png" });
  expect(response.statusCode).toBe(404);
  // A 404 is heuristically cacheable, so it must not go uncovered the way a
  // success response is. Its body is JSON, so app.ts's onSend hook overwrites
  // this route's own "private, no-store" with the app-wide "no-store" — a
  // stricter directive that forbids storage by every cache, private or
  // shared, so the outcome this route needs still holds.
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
});

it("refuses a filename that is not a two digit PNG", async () => {
  const { token } = await fileTwoRenders();
  for (const file of ["1.png", "01.jpg", "../../etc/passwd", "0001.png"]) {
    const response = await app.inject({
      method: "GET",
      url: `/export/${token}/${encodeURIComponent(file)}`,
    });
    expect(response.statusCode).toBe(404);
  }
});

it("stops serving once the grant has expired", async () => {
  const { id } = await fileTwoRenders();
  // A grant that was already dead when it was minted. FastifyInstance has no
  // `db` decoration, so the expiry is moved through grant()'s ttlMs rather
  // than through a direct UPDATE.
  const { token } = app.exports.grant(id, 3, -1);
  const response = await app.inject({ method: "GET", url: `/export/${token}/01.png` });
  expect(response.statusCode).toBe(404);
});

it("stops serving once the export is revoked", async () => {
  const { id, token } = await fileTwoRenders();
  expect(app.exports.revoke(id)).toBe(1);
  const response = await app.inject({ method: "GET", url: `/export/${token}/01.png` });
  expect(response.statusCode).toBe(404);
});

it("serves a slide with no credential on a password-protected deployment, while other routes stay locked", async () => {
  // This route's whole reason to exist: on a deployment where every other
  // path demands a session or a bearer, /export/ still has to answer a
  // caller with neither. makeTempApp() everywhere else in this file runs
  // with no password, which puts the server in "open" mode and lets every
  // request through regardless of the guard — a deployment this task's
  // property cannot actually be checked against. This test gets its own app
  // and its own lifecycle so it, and only it, runs secured.
  const secured = await makeTempApp({ password: "a-real-long-password-1" });
  try {
    expect(secured.authMode).toBe("required");

    // Proves the security is really on: a guarded path refuses a bare request.
    const guarded = await secured.inject({ method: "GET", url: "/api/projects" });
    expect(guarded.statusCode).toBe(401);

    const { id } = secured.projects.create({ accountId: "default" });
    const png = solidPng(40, 60);
    const mediaId = await secured.media.put(png, "png");
    secured.exports.putRender(id, 3, 0, {
      mediaId,
      width: 40,
      height: 60,
      bytes: png.byteLength,
    });
    const { token } = secured.exports.grant(id, 3);

    const response = await secured.inject({
      method: "GET",
      url: `/export/${token}/01.png`,
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await secured.close();
  }
});
