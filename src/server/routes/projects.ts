import type { FastifyInstance } from "fastify";
import { HttpError } from "../errors.js";
import { imageDimensions } from "../services/media.js";
import type { ProjectListOptions } from "../services/projects.js";
import { asFields, field, queryValue } from "./input.js";

interface IdParams {
  id: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function projectRoutes(app: FastifyInstance): void {
  app.get("/api/projects", (request) => ({
    projects: app.projects.list(projectListOptions(request.query)),
  }));

  app.post("/api/projects", (request) => {
    const body = asFields(request.body);
    return {
      project: app.projects.create({
        name: field(body, "name"),
        document: body["document"],
        description: field(body, "description"),
        hashtags: field(body, "hashtags"),
        accountId: field(body, "accountId"),
      }),
    };
  });

  app.get<{ Params: IdParams }>("/api/projects/:id", (request) => ({
    project: app.projects.require(request.params.id),
  }));

  app.put<{ Params: IdParams }>("/api/projects/:id", (request) => {
    const body = asFields(request.body);
    return {
      project: app.projects.save(request.params.id, {
        name: field(body, "name"),
        document: body["document"],
        version: field(body, "version"),
        description: field(body, "description"),
        hashtags: field(body, "hashtags"),
      }),
    };
  });

  app.delete<{ Params: IdParams }>("/api/projects/:id", (request) =>
    app.projects.remove(request.params.id),
  );

  app.patch<{ Params: IdParams }>("/api/projects/:id/status", (request) => ({
    project: app.projects.setStatus(
      request.params.id,
      field(asFields(request.body), "status"),
    ),
  }));

  /*
   * One rendered slide, uploaded by the editor when a slideshow becomes ready.
   *
   * One request per slide rather than the whole set in one body: six PNGs at
   * full resolution would sit uncomfortably close to MAX_BODY_BYTES, and a
   * per-slide write means a failure halfway leaves a partial set that
   * export_slideshow reports as pending rather than as a short slideshow.
   *
   * It lives under /api/projects rather than /api/slideshows because the
   * uploader is the browser, and the browser client speaks the projects family
   * (api.ts's setProjectStatus).
   */
  app.put<{ Params: { id: string; index: string } }>(
    "/api/projects/:id/renders/:index",
    async (request) => {
      const project = app.projects.require(request.params.id);
      const body = asFields(request.body);
      const version = field(body, "version");
      // Read as a real number before comparing, not coerced with Number() —
      // that turns a missing, boolean or array `version` into a number that
      // then either accidentally matches or 409s as a bogus "wrong version".
      if (typeof version !== "number" || !Number.isInteger(version))
        throw new HttpError(400, "The render needs an integer `version` field.");
      // A render depicts one version. Filing it against another would publish
      // pixels that do not match the composition an agent just read.
      if (version !== project.version) {
        throw new HttpError(409, "This render is for another version.", {
          currentVersion: project.version,
        });
      }

      const index = Number(request.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= project.slides.length) {
        throw new HttpError(
          400,
          `Slide ${request.params.index} is not one of this slideshow's ${String(project.slides.length)}.`,
        );
      }

      const bytes = decodePng(field(body, "data"));
      // imageDimensions recognizes JPEG/GIF/WebP too, so on its own it would
      // wave through a non-PNG image that app.media.put then files under a
      // ".png" extension the export route serves as image/png. This route
      // promises PNG, so the signature is checked, not just "some image".
      if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
        throw new HttpError(400, "The render is not a PNG.");
      const size = imageDimensions(bytes);
      if (size === null) throw new HttpError(400, "The render is not a PNG.");

      const mediaId = await app.media.put(bytes, "png");
      // ponytail: the version check above and this insert are not atomic.
      // app.media.put awaits, so another request can bump the slideshow past
      // `version` in between and this still lands. Harmless: putRender only
      // deletes strictly older versions, so a late insert can't clobber the
      // new one, and rendersFor filters by exact version, so no export reads
      // it. It just leaks one row (and its media file) until a later version
      // is rendered and sweeps it, or forever if none is. Wrap require+read+
      // putRender in one transaction if that leak ever needs to be bounded.
      app.exports.putRender(project.id, version, index, {
        mediaId,
        width: size.width,
        height: size.height,
        bytes: bytes.byteLength,
      });
      return {
        index,
        mediaId,
        width: size.width,
        height: size.height,
        bytes: bytes.byteLength,
      };
    },
  );
}

/** An absent status leaves the service on its default filter, the way `?? undefined` did. */
export function statusFilter(query: unknown): ProjectListOptions {
  const status = queryValue(query, "status");
  return status === null ? {} : { status };
}

/** statusFilter plus the `?account=` filter, shared with /api/slideshows. */
export function projectListOptions(query: unknown): ProjectListOptions {
  const account = queryValue(query, "account");
  return { ...statusFilter(query), ...(account === null ? {} : { accountId: account }) };
}

/** The bare base64 the editor's blobToBase64 sends — never a `data:` URI. */
function decodePng(data: unknown): Buffer {
  if (typeof data !== "string" || !data)
    throw new HttpError(400, "The render needs a base64 `data` field.");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new HttpError(400, "The render data was not valid base64.");
  return bytes;
}
