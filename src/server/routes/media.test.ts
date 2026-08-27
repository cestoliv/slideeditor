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

async function addBackground(): Promise<{ url: string; bytes: number }> {
  const data = pngFixture(80, 100);
  const response = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: {
      kind: "background",
      name: "Beach",
      contentType: "image/png",
      data,
      accountId: "default",
    },
  });
  expect(response.statusCode).toBe(200);
  return {
    url: String(response.json().item.url),
    bytes: Buffer.from(data, "base64").byteLength,
  };
}

it("serves the stored bytes with a cache that never expires", async () => {
  const { url, bytes } = await addBackground();
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  // The name is the sha256 of the bytes, so the content behind it cannot change.
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.rawPayload.byteLength).toBe(bytes);
});

it("answers a HEAD with the headers and no body", async () => {
  const { url, bytes } = await addBackground();
  const response = await app.inject({ method: "HEAD", url });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-length"]).toBe(String(bytes));
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(response.rawPayload.byteLength).toBe(0);
});

it("answers a name that is not a content hash with 404", async () => {
  for (const name of [
    "nope.png",
    "..%2F..%2Fetc%2Fpasswd",
    `${"a".repeat(64)}.toolongext`,
    "a".repeat(64),
  ]) {
    const response = await app.inject({ method: "GET", url: `/media/${name}` });
    expect(response.statusCode, name).toBe(404);
  }
});

it("does not serve a file outside the media directory", async () => {
  // The database sits one level up from the media files and always exists, so
  // a traversal that worked would come back 200 with real bytes.
  for (const name of [
    "..%2Fslide-studio.db",
    "..%2F..%2Fetc%2Fhosts",
    "%2Fetc%2Fhosts",
  ]) {
    const response = await app.inject({ method: "GET", url: `/media/${name}` });
    expect(response.statusCode, name).toBe(404);
    expect(response.json().error, name).toBe("No such media file.");
  }
});

it("answers a well-formed name with no file behind it with the JSON 404", async () => {
  const response = await app.inject({
    method: "GET",
    url: `/media/${"a".repeat(64)}.png`,
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("No such media file.");
  expect(response.headers["cache-control"]).toBe("no-store");
});
