import type { FastifyInstance } from "fastify";
import {
  composeDocument,
  toComposition,
  validateComposition,
} from "../../shared/compose/index.js";
import type { CompositionSource } from "../../shared/compose/index.js";
import type { Ratio, Slide } from "../../shared/schema/index.js";
import type { StoredProject } from "../services/projects.js";
import { editUrl } from "../urls.js";
import { asFields, field } from "./input.js";
import { statusFilter } from "./projects.js";

interface IdParams {
  id: string;
}

export function slideshowRoutes(app: FastifyInstance): void {
  app.get("/api/slideshows", (request) => ({
    slideshows: app.projects
      .list(statusFilter(request.query))
      .map((summary) => ({ ...summary, editUrl: editUrl(app.baseUrl(), summary.id) })),
  }));

  app.get<{ Params: IdParams }>("/api/slideshows/:id", (request) => {
    const project = app.projects.require(request.params.id);
    return {
      slideshow: {
        ...toComposition(asComposable(project)),
        status: project.status,
        description: project.description,
        hashtags: project.hashtags,
      },
      editUrl: editUrl(app.baseUrl(), project.id),
    };
  });

  app.post("/api/slideshows", (request) => {
    const body = asFields(request.body);
    const slides = validateComposition(body["slides"]);
    const document = composeDocument({
      ratio: asRatio(body["ratio"]),
      slides,
      library: app.library,
    });
    const project = app.projects.create({
      name: field(body, "name") || "Agent slideshow",
      document,
      description: field(body, "description"),
      hashtags: field(body, "hashtags"),
    });
    return {
      id: project.id,
      version: project.version,
      editUrl: editUrl(app.baseUrl(), project.id),
      slideCount: project.slides.length,
      // Echoed so a caller sees the caption as it was stored, hashtags and all,
      // without a second read to find out what its input became.
      description: project.description,
      hashtags: project.hashtags,
    };
  });

  app.put<{ Params: IdParams }>("/api/slideshows/:id", (request) => {
    const body = asFields(request.body);
    const id = request.params.id;
    const current = app.projects.require(id);
    const slides = validateComposition(body["slides"]);
    const document = composeDocument({
      // The old route read `body.ratio || current.ratio`, so a ratio that is
      // absent or falsy keeps the one the slideshow already has.
      ratio: body["ratio"] ? asRatio(body["ratio"]) : current.ratio,
      slides,
      library: app.library,
      previous: asComposable(current),
    });
    const project = app.projects.save(id, {
      name: field(body, "name") ?? current.name,
      document,
      version: field(body, "version") ?? current.version,
      // Absent, not empty: a caller editing the slides alone leaves the caption
      // where it is rather than clearing it (ProjectSaveInput).
      description: field(body, "description"),
      hashtags: field(body, "hashtags"),
    });
    return {
      id: project.id,
      version: project.version,
      editUrl: editUrl(app.baseUrl(), project.id),
      slideCount: project.slides.length,
      description: project.description,
      hashtags: project.hashtags,
    };
  });

  app.patch<{ Params: IdParams }>("/api/slideshows/:id/status", (request) => {
    const project = app.projects.setStatus(
      request.params.id,
      field(asFields(request.body), "status"),
    );
    return {
      id: project.id,
      status: project.status,
      editUrl: editUrl(app.baseUrl(), project.id),
    };
  });
}

/**
 * `composeDocument` types its ratio, and it lives in src/shared, so the two
 * numbers are read here instead. It coerces both with `Number` and falls back
 * to the default when either is not finite, which is what a ratio of the wrong
 * shape produced before.
 */
function asRatio(value: unknown): Ratio | undefined {
  if (value === null || value === undefined) return undefined;
  const source = asFields(value);
  return { w: Number(source["w"]), h: Number(source["h"]) };
}

/**
 * The stored document keeps a human's slides verbatim, so the service types
 * them `unknown[]` (task-7-report, point 3). The compose engine reads every
 * field defensively and the old router handed it these same rows, so the
 * document crosses unparsed rather than being reshaped by documentSchema on
 * the way through.
 */
function asComposable(project: StoredProject): CompositionSource {
  return { ...project, slides: project.slides as Slide[] };
}
