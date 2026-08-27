import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { HttpError } from "../errors.js";
import { packageRoot } from "../plugins/client.js";
import { builtinFontFileName } from "../services/fonts.js";
import { asFields, field } from "./input.js";

interface IdParams {
  id: string;
}

const BUILTIN_FONTS_DIR = join(packageRoot(), "assets");
const FONT_FILE_NAME = /^([a-z0-9-]{1,64})\.(ttf|otf|woff2?)$/;
const FONT_MIME: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function fontRoutes(app: FastifyInstance): void {
  app.get("/api/fonts", () => ({ fonts: app.fonts.list() }));

  app.post("/api/fonts", async (request) => {
    const body = asFields(request.body);
    const family = String(field(body, "family") ?? "").trim();
    if (!family) throw new HttpError(400, "A font family name is required.");
    return { font: await app.fonts.addGoogleFont(family) };
  });

  app.delete<{ Params: IdParams }>("/api/fonts/:id", (request) => {
    app.fonts.remove(request.params.id);
    return { removed: request.params.id };
  });

  app.get<{ Params: { file: string } }>("/fonts/:file", async (request, reply) => {
    const match = FONT_FILE_NAME.exec(request.params.file);
    if (!match) return notFound(reply);
    // Derived from FontService's own BUILTIN_FONTS catalogue (builtinFontFileName)
    // rather than a hand-maintained slug map here, so a new builtin never 404s
    // silently for want of a second edit. The canonical name carries the
    // catalogue's real extension, so a requested extension that does not match
    // it (a stale link, a guess) 404s instead of serving the wrong Content-Type.
    const slug = match[1] ?? "";
    const ext = match[2] ?? "";
    const canonical = builtinFontFileName(slug);
    if (!canonical || !canonical.endsWith(`.${ext}`)) return notFound(reply);
    const path = join(BUILTIN_FONTS_DIR, canonical);
    if (!normalize(path).startsWith(normalize(BUILTIN_FONTS_DIR))) return notFound(reply);
    try {
      // Unlike /media/<hash>.ext, this name is not content-addressed: a future
      // release can ship different bytes under the same TikTokSans.ttf path.
      // `immutable, max-age=1y` promised a browser it would never need to
      // check again, so a replaced file stayed invisible to every visitor
      // holding that promise for up to a year. An ETag keeps a cache reusing
      // the response while still catching a change the moment it happens —
      // but this route has no auth guard (identity.ts), so the ETag must come
      // from file metadata (mtime + size), not from reading and hashing the
      // 1.2MB body on every request: that read+hash used to run before the
      // if-none-match check even fired, letting an anonymous client drive
      // unbounded reads and SHA-256 passes with ordinary conditional requests.
      const stats = await stat(path);
      const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).header("ETag", etag).send();
      }
      const body = await readFile(path);
      return reply
        .header("Content-Type", FONT_MIME[ext] ?? "application/octet-stream")
        .header("Cache-Control", "public, max-age=3600, must-revalidate")
        .header("ETag", etag)
        .header("X-Content-Type-Options", "nosniff")
        .send(body);
    } catch {
      return notFound(reply);
    }
  });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "No such font file." });
}
