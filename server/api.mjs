import { HttpError } from "./library.mjs";
import { composeDocument, toComposition, validateComposition } from "./compose.mjs";

const MAX_BODY_BYTES = 30 * 1024 * 1024;

export function createApi({ library, projects, events, baseUrl }) {
  const routes = [
    ["GET", /^\/api\/health$/, () => ({ ok: true, name: "slide-studio" })],

    ["GET", /^\/api\/library$/, (context) => library.list({
      kind: context.query.get("kind") || null,
      query: context.query.get("q") || "",
      limit: context.query.get("limit"),
      offset: context.query.get("offset"),
    })],

    ["GET", /^\/api\/library\/([^/]+)$/, (context) => {
      const item = library.require(context.params[0]);
      return { item, usedBy: library.usedBy(item.id) };
    }],

    ["POST", /^\/api\/library$/, async (context) => {
      const body = await context.json();
      const bytes = decodeImage(body.data);
      const item = await library.create({ ...body, bytes, contentType: body.contentType });
      return { item };
    }],

    ["PATCH", /^\/api\/library\/([^/]+)$/, async (context) => ({
      item: library.update(context.params[0], await context.json()),
    })],

    ["DELETE", /^\/api\/library\/([^/]+)$/, (context) =>
      library.remove(context.params[0], { force: context.query.get("force") === "1" })],

    ["GET", /^\/api\/projects$/, () => ({ projects: projects.list() })],

    ["POST", /^\/api\/projects$/, async (context) => {
      const body = await context.json();
      return { project: projects.create({ name: body.name, document: body.document }) };
    }],

    ["GET", /^\/api\/projects\/([^/]+)$/, (context) => ({ project: projects.require(context.params[0]) })],

    ["PUT", /^\/api\/projects\/([^/]+)$/, async (context) => {
      const body = await context.json();
      return { project: projects.save(context.params[0], body) };
    }],

    ["DELETE", /^\/api\/projects\/([^/]+)$/, (context) => projects.remove(context.params[0])],

    ["GET", /^\/api\/slideshows$/, () => ({
      slideshows: projects.list().map((summary) => ({ ...summary, editUrl: editUrl(baseUrl(), summary.id) })),
    })],

    ["GET", /^\/api\/slideshows\/([^/]+)$/, (context) => {
      const project = projects.require(context.params[0]);
      return { slideshow: toComposition(project), editUrl: editUrl(baseUrl(), project.id) };
    }],

    ["POST", /^\/api\/slideshows$/, async (context) => {
      const body = await context.json();
      const slides = validateComposition(body.slides);
      const document = composeDocument({ ratio: body.ratio, slides, library });
      const project = projects.create({ name: body.name || "Agent slideshow", document });
      return { id: project.id, version: project.version, editUrl: editUrl(baseUrl(), project.id), slideCount: project.slides.length };
    }],

    ["PUT", /^\/api\/slideshows\/([^/]+)$/, async (context) => {
      const body = await context.json();
      const id = context.params[0];
      const current = projects.require(id);
      const slides = validateComposition(body.slides);
      const document = composeDocument({
        ratio: body.ratio || current.ratio,
        slides,
        library,
        previous: current,
      });
      const project = projects.save(id, {
        name: body.name ?? current.name,
        document,
        version: body.version ?? current.version,
      });
      return { id: project.id, version: project.version, editUrl: editUrl(baseUrl(), project.id), slideCount: project.slides.length };
    }],
  ];

  return async function handle(request, response, url) {
    if (url.pathname === "/api/events") {
      events.subscribe(request, response);
      return true;
    }
    // Several routes share a path, so match the method too before giving up.
    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (request.method !== method) continue;
      try {
        const result = await handler({
          params: match.slice(1).map(decodeURIComponent),
          query: url.searchParams,
          json: () => readJson(request),
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.message, ...(error.details || {}) });
        } else {
          console.error(error);
          sendJson(response, 500, { error: "The server hit an unexpected problem." });
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(response, 405, { error: `${request.method} is not allowed here.` });
      return true;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: `No route for ${url.pathname}` });
      return true;
    }
    return false;
  };
}

export function editUrl(base, projectId) {
  return `${base}/projects/${projectId}`;
}

function decodeImage(data) {
  if (typeof data !== "string" || !data) throw new HttpError(400, "The upload needs a base64 `data` field.");
  const payload = data.includes(",") && data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length) throw new HttpError(400, "The upload data was not valid base64.");
  return bytes;
}

export function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "The request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

export function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
