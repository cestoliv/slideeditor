import { stat } from "node:fs/promises";
import { normalize } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { typeForExtension } from "../services/media.js";

// A media file is named for the sha256 of its bytes, so anything else is a miss.
const MEDIA_NAME = /^([0-9a-f]{64})\.([a-z0-9]{2,5})$/;

export function mediaRoutes(app: FastifyInstance): void {
  app.get<{ Params: { file: string } }>("/media/:file", async (request, reply) => {
    const match = MEDIA_NAME.exec(request.params.file);
    // Reject traversal before touching the filesystem.
    if (!match) return notFound(reply);
    const [, mediaId = "", ext = ""] = match;
    const file = app.media.pathFor(mediaId, ext);
    if (!normalize(file).startsWith(normalize(app.media.directory)))
      return notFound(reply);
    try {
      const info = await stat(file);
      const body = await app.media.read(mediaId, ext);
      return (
        reply
          .header("Content-Type", typeForExtension(ext))
          .header("Content-Length", info.size)
          // The name is the hash of the bytes, so the content can never change.
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .header("X-Content-Type-Options", "nosniff")
          .send(body)
      );
    } catch {
      return notFound(reply);
    }
  });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "No such media file." });
}
