import type { FastifyInstance, FastifyReply } from "fastify";
import { typeForExtension } from "../services/media.js";

/*
 * A slide's file name inside an export: the 1-based slide number, padded to two
 * digits, plus the extension of one of the three formats. Matched before the
 * database is touched, the way routes/media.ts matches MEDIA_NAME before
 * touching the filesystem. Two digits exactly, so a slideshow with a hundred
 * slides fails here rather than serving an ambiguous name.
 *
 * A name that parses is still not a name this token serves. The extension has
 * to match the grant's own format, which ExportService.resolve checks.
 */
const SLIDE_NAME = /^(\d{2})\.(png|jpg|webp)$/;

/**
 * The one route in this server that answers without a credential.
 *
 * A scheduling tool downloads these URLs from its own servers, with no cookie
 * and no bearer, which is why guardFor names /export/ explicitly. The token is
 * the credential.
 */
export function exportRoutes(app: FastifyInstance): void {
  app.get<{ Params: { token: string; file: string } }>(
    "/export/:token/:file",
    async (request, reply) => {
      // Set on every response this route sends, 404 included: a 404 is
      // heuristically cacheable, and a slide that is merely not rendered yet
      // must not get cached as absent and served that way once the render
      // lands.
      reply
        .header("Cache-Control", "private, no-store")
        .header("X-Robots-Tag", "noindex, nofollow")
        .header("X-Content-Type-Options", "nosniff");

      const match = SLIDE_NAME.exec(request.params.file);
      if (!match) return notFound(reply);
      // The URL is 1-based and the table is 0-based.
      const index = Number(match[1]) - 1;
      if (index < 0) return notFound(reply);
      const ext = match[2] ?? "";

      const render = app.exports.resolve(request.params.token, index, ext);
      // An unknown token, an expired one, a revoked one, an extension the grant
      // was not minted for and an index with no row all arrive here as null,
      // and all leave as 404. Saying which would tell a stranger whether a
      // token ever existed, or which format it holds.
      if (render === null) return notFound(reply);

      try {
        const body = await app.media.read(render.mediaId, ext);
        return reply
          .header("Content-Type", typeForExtension(ext))
          .header("Content-Length", body.byteLength)
          .send(body);
      } catch {
        // The row survived its file, which nothing should do. It reads to a
        // caller as a link that no longer works, which it is.
        return notFound(reply);
      }
    },
  );
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "No such export." });
}
