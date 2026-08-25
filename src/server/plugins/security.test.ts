import { connect } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

const REMOTE = "192.168.1.20";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

it("accepts a request with no Host header", async () => {
  // inject always fills a Host header in, so this one goes down a real socket.
  // HTTP/1.0 is the version that lets a request leave it out.
  const named = await makeTempApp({ allowedHosts: ["studio.local"] });
  try {
    await named.listen({ port: 0, host: "127.0.0.1" });
    expect(await rawRequest(named, "GET /api/health HTTP/1.0\r\n\r\n")).toContain(
      "200 OK",
    );
    expect(
      await rawRequest(
        named,
        "GET /api/health HTTP/1.1\r\nHost: evil.example.com\r\n\r\n",
      ),
    ).toContain("421");
  } finally {
    await named.close();
  }
});

/** One request written by hand, because inject cannot leave a header out. */
function rawRequest(app: FastifyInstance, request: string): Promise<string> {
  const address = app.addresses()[0];
  if (!address) throw new Error("The test server is not listening.");
  return new Promise((resolve, reject) => {
    const socket = connect(address.port, "127.0.0.1", () => socket.end(request));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

it("accepts a bare IPv4 Host", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { host: "192.168.1.20:4173" },
  });
  expect(response.statusCode).toBe(200);
});

it("accepts a bracketed IPv6 Host", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { host: "[::1]:4173" },
  });
  expect(response.statusCode).toBe(200);
});

it("rejects an unknown hostname, which is how rebinding would arrive", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { host: "evil.example.com" },
  });
  expect(response.statusCode).toBe(421);
  expect(response.json().error).toBe("This Host header is not allowed.");
});

it("guards the client and the media as well as the API", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/projects/anything",
    headers: { host: "evil.example.com" },
  });
  expect(response.statusCode).toBe(421);
});

it("accepts a hostname passed as an allowed host", async () => {
  const named = await makeTempApp({ allowedHosts: ["localhost", "studio.local"] });
  try {
    const allowed = await named.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "STUDIO.local:4173" },
    });
    expect(allowed.statusCode).toBe(200);
    const other = await named.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "studio.remote" },
    });
    expect(other.statusCode).toBe(421);
  } finally {
    await named.close();
  }
});

it("skips the token for a loopback request", async () => {
  for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress,
    });
    expect(response.statusCode, remoteAddress).toBe(200);
  }
});

it("requires a bearer token for a non-loopback request", async () => {
  const missing = await app.inject({
    method: "GET",
    url: "/api/health",
    remoteAddress: REMOTE,
  });
  expect(missing.statusCode).toBe(401);
  expect(missing.headers["www-authenticate"]).toBe("Bearer");
  expect(missing.json().error).toBe("Send Authorization: Bearer <token>.");

  const wrong = await app.inject({
    method: "GET",
    url: "/api/health",
    remoteAddress: REMOTE,
    headers: { authorization: "Bearer nope" },
  });
  expect(wrong.statusCode).toBe(401);

  const right = await app.inject({
    method: "GET",
    url: "/api/health",
    remoteAddress: REMOTE,
    headers: { authorization: `bearer ${app.token}` },
  });
  expect(right.statusCode).toBe(200);
});

it("guards the path Fastify routes, not the one the client typed", async () => {
  // Fastify matches on the decoded path, so every one of these reaches a real
  // API route. A guard that reads the raw target sees no /api/ in them and lets
  // them through, which hands the whole API to any client on the network.
  const encoded = [
    "/%61pi/projects",
    "/ap%69/projects",
    "/api/pro%6Aects",
    "/%61pi/librar%79",
    "/%61%70%69/health",
    "/%61pi/slideshows?status=all",
  ];
  for (const url of encoded) {
    const anonymous = await app.inject({ method: "GET", url, remoteAddress: REMOTE });
    expect(anonymous.statusCode, url).toBe(401);
    expect(anonymous.json().error, url).toBe("Send Authorization: Bearer <token>.");

    const authorized = await app.inject({
      method: "GET",
      url,
      remoteAddress: REMOTE,
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(authorized.statusCode, url).toBe(200);
  }
});

it("keeps an API path that matches no route behind the token", async () => {
  // A 404 here would tell an unauthenticated caller which routes exist.
  const anonymous = await app.inject({
    method: "GET",
    url: "/api/nope",
    remoteAddress: REMOTE,
  });
  expect(anonymous.statusCode).toBe(401);

  const authorized = await app.inject({
    method: "GET",
    url: "/api/nope",
    remoteAddress: REMOTE,
    headers: { authorization: `Bearer ${app.token}` },
  });
  expect(authorized.statusCode).toBe(404);
});

it("hands a path that decodes to no route the client, not the API", async () => {
  // Double encoding and a case change survive one decode as themselves, so they
  // match nothing. What comes back is the public client, never API data.
  for (const url of ["/%2561pi/projects", "/%41PI/projects", "/api%2Fprojects"]) {
    const response = await app.inject({ method: "GET", url, remoteAddress: REMOTE });
    expect(response.statusCode, url).toBe(200);
    expect(response.headers["content-type"], url).toContain("text/html");
    expect(response.body, url).not.toContain("projects");
  }
});

it("accepts the token as a query parameter", async () => {
  const response = await app.inject({
    method: "GET",
    url: `/api/health?token=${encodeURIComponent(app.token)}`,
    remoteAddress: REMOTE,
  });
  expect(response.statusCode).toBe(200);
});

it("rejects a token of the wrong length without throwing", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    remoteAddress: REMOTE,
    headers: { authorization: `Bearer ${app.token}x` },
  });
  expect(response.statusCode).toBe(401);
  expect(response.json().error).toBe("Send Authorization: Bearer <token>.");
});

it("leaves the editor and its media open to the browser", async () => {
  const media = await app.inject({
    method: "GET",
    url: "/media/nope.png",
    remoteAddress: REMOTE,
  });
  expect(media.statusCode).toBe(404);
  expect(media.json().error).toBe("No such media file.");
});

it("keeps the MCP endpoint behind the token", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: REMOTE,
  });
  expect(response.statusCode).toBe(401);
});
