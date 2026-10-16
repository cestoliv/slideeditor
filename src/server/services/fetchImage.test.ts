import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { asHttpError, catchError, solidPng } from "../testing.js";
import { fetchImage, type FetchImageOptions } from "./fetchImage.js";
import { MAX_UPLOAD_BYTES } from "./media.js";

const PNG = solidPng(4, 3);
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    switch (request.url) {
      case "/image.png":
        // Like Wikimedia, refuse a client that does not name itself.
        if (!request.headers["user-agent"]) {
          response.writeHead(403);
          return response.end();
        }
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(PNG);
      case "/moved":
        response.writeHead(302, { Location: "/image.png" });
        return response.end();
      case "/loop":
        response.writeHead(302, { Location: "/loop" });
        return response.end();
      case "/to-file":
        response.writeHead(302, { Location: "file:///etc/passwd" });
        return response.end();
      case "/vector.svg":
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        return response.end("<svg/>");
      case "/page":
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end("<html></html>");
      case "/declared-huge":
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(MAX_UPLOAD_BYTES + 1),
        });
        return response.end();
      case "/streamed-huge": {
        // No Content-Length, so only the byte count can stop it.
        response.writeHead(200, { "Content-Type": "image/png" });
        const chunk = Buffer.alloc(1024 * 1024);
        const chunks = Math.ceil(MAX_UPLOAD_BYTES / chunk.length) + 1;
        Readable.from(Array.from({ length: chunks }, () => chunk))
          .on("error", () => undefined)
          .pipe(response);
        return;
      }
      default:
        response.writeHead(404);
        return response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const open = { allowPrivate: true };

async function status(url: string, options: FetchImageOptions = open): Promise<number> {
  return asHttpError(await catchError(() => fetchImage(url, options))).status;
}

it("downloads an image and reports its type", async () => {
  const image = await fetchImage(`${base}/image.png`, open);
  expect(image.contentType).toBe("image/png");
  expect(image.bytes.equals(PNG)).toBe(true);
});

it("follows a redirect", async () => {
  const image = await fetchImage(`${base}/moved`, open);
  expect(image.bytes.equals(PNG)).toBe(true);
});

it("refuses private addresses, literal or resolved", async () => {
  const port = new URL(base).port;
  for (const url of [
    `http://127.0.0.1:${port}/image.png`,
    `http://localhost:${port}/image.png`,
    "http://10.0.0.1/image.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/image.png",
    "http://[::ffff:127.0.0.1]/image.png",
    "http://[::127.0.0.1]/image.png",
    "http://2130706433/image.png",
  ]) {
    expect(await status(url, {})).toBe(400);
  }
});

it("refuses a scheme other than http and https, and a non-URL", async () => {
  expect(await status("file:///etc/passwd")).toBe(400);
  expect(await status("not a url")).toBe(400);
});

it("checks every redirect hop again", async () => {
  expect(await status(`${base}/to-file`)).toBe(400);
  expect(await status(`${base}/loop`)).toBe(502);
});

it("refuses a response that is not an image it can measure", async () => {
  expect(await status(`${base}/page`)).toBe(415);
  expect(await status(`${base}/vector.svg`)).toBe(415);
});

it("refuses an error response and an unreachable host", async () => {
  expect(await status(`${base}/missing`)).toBe(502);
  // A port that was bound and then released refuses the connection.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  expect(await status(`http://127.0.0.1:${port}/image.png`)).toBe(502);
});

it("refuses a body over 25 MB, declared or streamed", async () => {
  expect(await status(`${base}/declared-huge`)).toBe(413);
  expect(await status(`${base}/streamed-huge`)).toBe(413);
});
