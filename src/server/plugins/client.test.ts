import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

const clientRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
  "web",
);
// `npm ci` runs prepare, which builds the client, so CI always has one. A
// working tree that has never run a build skips the two tests that need it.
const built = existsSync(join(clientRoot, "index.html"));

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

it.runIf(built)("serves the built client at the root", async () => {
  const response = await app.inject({ method: "GET", url: "/" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/html");
  expect(response.body).toContain('<div id="root">');
  expect(response.headers["cache-control"]).toBe("no-cache");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
});

it.runIf(built)("hands a deep link back to the client to route", async () => {
  for (const url of ["/projects/8f14e45f", "/library/backgrounds", "/library"]) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(200);
    expect(response.headers["content-type"], url).toContain("text/html");
  }
});

it.runIf(built)("lets a browser keep a fingerprinted asset forever", async () => {
  const [name] = readdirSync(join(clientRoot, "assets"));
  if (!name) throw new Error("The built client has no fingerprinted assets.");
  const response = await app.inject({ method: "GET", url: `/assets/${name}` });
  expect(response.statusCode).toBe(200);
  // vite writes the content hash into the name, so the bytes behind it are fixed.
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
});

it("does not hand this server's own paths to the client", async () => {
  for (const url of ["/media/nope.png", "/api/nope"]) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(404);
    expect(response.headers["content-type"], url).not.toContain("text/html");
  }

  // /mcp is a route of this server's own since buildApp mounts it, so it answers
  // for itself instead of 404ing. What matters here is unchanged: it is the MCP
  // transport talking, never the client.
  const mcp = await app.inject({ method: "GET", url: "/mcp" });
  expect(mcp.headers["content-type"]).not.toContain("text/html");
  expect(mcp.json()).toMatchObject({ jsonrpc: "2.0" });
});

it("answers a missing file with a plain 404 rather than the client", async () => {
  const response = await app.inject({ method: "GET", url: "/missing.js" });
  expect(response.statusCode).toBe(404);
  expect(response.body).toBe("Not found");
  expect(response.headers["content-type"]).toContain("text/plain");
});

it("answers a write to a client path with a 404, not the client", async () => {
  const response = await app.inject({ method: "POST", url: "/projects/8f14e45f" });
  expect(response.statusCode).toBe(404);
  expect(response.body).toBe("Not found");
});
