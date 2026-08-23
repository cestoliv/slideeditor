import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, dataPaths } from "./db.mjs";
import { MediaStore, typeForExtension } from "./media.mjs";
import { LibraryService } from "./library.mjs";
import { ProjectService } from "./projects.mjs";
import { EventBus } from "./events.mjs";
import { createApi, sendJson, readJson } from "./api.mjs";
import { createMcpServer, handleMcpRequest } from "./mcp.mjs";
import { loadToken, isAuthorized, isAllowedHost } from "./auth.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/api.js", ["api.js", "text/javascript; charset=utf-8"]],
  ["/zip.js", ["zip.js", "text/javascript; charset=utf-8"]],
  ["/assets/TikTokSans.ttf", ["assets/TikTokSans.ttf", "font/ttf"]],
  ["/assets/airdrop.svg", ["assets/airdrop.svg", "image/svg+xml"]],
  ["/assets/Octicons-mark-github.svg", ["assets/Octicons-mark-github.svg", "image/svg+xml"]],
  ["/assets/favicon.svg", ["assets/favicon.svg", "image/svg+xml"]],
]);

// Routes the single-page editor owns. Everything else that is not a known file is a 404.
const APP_ROUTES = [/^\/projects\/[^/]+\/?$/, /^\/library(\/(backgrounds|assets))?\/?$/];

export function parseArguments(argv) {
  // Never package-relative: run through npx and that directory is a throwaway
  // cache, so the library and every slideshow would vanish between runs.
  const options = {
    host: "127.0.0.1",
    port: Number(process.env.SLIDE_STUDIO_PORT) || 4173,
    data: process.env.SLIDE_STUDIO_DATA || join(homedir(), ".slide-studio"),
    allowedHosts: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split("=");
    const value = inline ?? argv[index + 1];
    if (flag === "--host") options.host = value;
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--data") options.data = value;
    else if (flag === "--allowed-host") options.allowedHosts.push(String(value).toLowerCase());
    else continue;
    if (inline === undefined) index += 1;
  }
  return options;
}

export function createApp(options) {
  const paths = dataPaths(options.data);
  const db = openDb(paths.database);
  const media = new MediaStore(paths.media);
  const events = new EventBus();
  const library = new LibraryService(db, media);
  const projects = new ProjectService(db, events, library);
  const token = loadToken(paths.token);

  const publicHost = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
  const baseUrl = () => `http://${publicHost}:${options.port}`;
  const allowedHosts = [...new Set(["localhost", publicHost.toLowerCase(), ...(options.allowedHosts || [])])];

  const api = createApi({ library, projects, events, baseUrl });
  // Built per request: stateless MCP cannot share one server across transports.
  const buildMcpServer = () => createMcpServer({ library, projects, baseUrl });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", baseUrl());
    try {
      if (!isAllowedHost(request, allowedHosts)) {
        sendJson(response, 421, { error: "This Host header is not allowed." });
        return;
      }
      const needsToken = url.pathname.startsWith("/api/") || url.pathname === "/mcp";
      if (needsToken && !isAuthorized(request, token)) {
        response.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        response.end(JSON.stringify({ error: "Send Authorization: Bearer <token>." }));
        return;
      }

      if (url.pathname === "/mcp") {
        const body = request.method === "POST" ? await readJson(request) : undefined;
        await handleMcpRequest(buildMcpServer, request, response, body);
        return;
      }
      if (await api(request, response, url)) return;
      if (url.pathname.startsWith("/media/")) {
        await serveMedia(paths.media, url.pathname.slice("/media/".length), request, response);
        return;
      }
      await serveStatic(url, request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: "The server hit an unexpected problem." });
      else response.end();
    }
  });

  return { server, db, events, token, baseUrl, options, services: { library, projects, media } };
}

async function serveMedia(directory, name, request, response) {
  // Reject traversal before touching the filesystem.
  if (!/^[0-9a-f]{64}\.[a-z0-9]{2,5}$/.test(name)) {
    sendJson(response, 404, { error: "No such media file." });
    return;
  }
  const file = join(directory, name);
  if (!normalize(file).startsWith(normalize(directory))) {
    sendJson(response, 404, { error: "No such media file." });
    return;
  }
  try {
    const info = await stat(file);
    const body = request.method === "HEAD" ? null : await readFile(file);
    response.writeHead(200, {
      "Content-Type": typeForExtension(name.split(".").pop()),
      "Content-Length": info.size,
      // The name is the hash of the bytes, so the content can never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body ?? undefined);
  } catch {
    sendJson(response, 404, { error: "No such media file." });
  }
}

async function serveStatic(url, request, response) {
  const entry = STATIC_FILES.get(url.pathname)
    || (APP_ROUTES.some((pattern) => pattern.test(url.pathname)) ? STATIC_FILES.get("/") : null);
  if (!entry || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const [relativePath, contentType] = entry;
  const body = await readFile(join(root, relativePath));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

export function start(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const app = createApp(options);
  app.server.listen(options.port, options.host, () => {
    console.log(`Slide Studio is running at ${app.baseUrl()}`);
    console.log(`MCP endpoint: ${app.baseUrl()}/mcp`);
    console.log(`Data directory: ${options.data}`);
    if (options.host !== "127.0.0.1") {
      console.log(`Remote access token: ${app.token}`);
      console.log("Requests from other machines must send: Authorization: Bearer <token>");
    }
  });
  return app;
}
