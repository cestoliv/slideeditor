import type { FastifyInstance } from "fastify";
import { HttpError } from "../errors.js";
import { asFields, countValue, field, queryValue } from "./input.js";

interface IdParams {
  id: string;
}

export function libraryRoutes(app: FastifyInstance): void {
  app.get("/api/library", (request) => {
    const limit = countValue(request.query, "limit");
    const offset = countValue(request.query, "offset");
    return app.library.list({
      // The service answers an unknown kind or sort itself, one with a 400 and
      // the other by falling back to "recent", so both cross unchecked.
      kind: queryValue(request.query, "kind") || null,
      query: queryValue(request.query, "q") || "",
      sort: queryValue(request.query, "sort") || "recent",
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    });
  });

  app.get<{ Params: IdParams }>("/api/library/:id", (request) => {
    const item = app.library.require(request.params.id);
    return { item, usedBy: app.library.usedBy(item.id) };
  });

  app.post("/api/library", async (request) => {
    const body = asFields(request.body);
    const bytes = decodeImage(body["data"]);
    const item = await app.library.create({
      kind: field(body, "kind"),
      name: field(body, "name"),
      description: field(body, "description"),
      usage: field(body, "usage"),
      tags: field(body, "tags"),
      contentType: field(body, "contentType"),
      width: field(body, "width"),
      height: field(body, "height"),
      bytes,
    });
    return { item };
  });

  app.patch<{ Params: IdParams }>("/api/library/:id", (request) => {
    const body = asFields(request.body);
    return {
      item: app.library.update(request.params.id, {
        name: field(body, "name"),
        description: field(body, "description"),
        usage: field(body, "usage"),
        tags: field(body, "tags"),
        kind: field(body, "kind"),
      }),
    };
  });

  app.delete<{ Params: IdParams }>("/api/library/:id", (request) =>
    app.library.remove(request.params.id, {
      force: queryValue(request.query, "force") === "1",
    }),
  );
}

/** Ported from server/api.mjs:148-154. */
function decodeImage(data: unknown): Buffer {
  if (typeof data !== "string" || !data)
    throw new HttpError(400, "The upload needs a base64 `data` field.");
  const payload =
    data.includes(",") && data.startsWith("data:")
      ? data.slice(data.indexOf(",") + 1)
      : data;
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length) throw new HttpError(400, "The upload data was not valid base64.");
  return bytes;
}
