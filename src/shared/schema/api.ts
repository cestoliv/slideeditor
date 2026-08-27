import { z } from "zod";
import { assignLayerOrder, documentSchema, ratioSchema } from "./document.js";
import type { Ratio, SlideDocument } from "./document.js";

// Matches STATUSES in server/projects.mjs:5.
export const SLIDESHOW_STATUSES = ["draft", "ready", "published"] as const;
export const slideshowStatusSchema = z.enum(SLIDESHOW_STATUSES).catch("draft");

// Published work is done, so it stays out of the way until asked for.
// Matches DEFAULT_STATUS_FILTER in server/projects.mjs:7.
export const DEFAULT_STATUS_FILTER = ["draft", "ready"] as const;

export type SlideshowStatus = (typeof SLIDESHOW_STATUSES)[number];

/*
 * The frames the event bus broadcasts. The server builds them
 * (src/server/services/events.ts) and the browser parses them
 * (src/web/app/events.ts), so the union lives here rather than once on each
 * side: a renamed field would otherwise make the client's safeParse drop the
 * frame with no error, no log, and a green suite.
 */
export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project.changed"),
    projectId: z.string(),
    version: z.number(),
  }),
  z.object({
    type: z.literal("project.status"),
    projectId: z.string(),
    status: slideshowStatusSchema,
  }),
  z.object({ type: z.literal("project.removed"), projectId: z.string() }),
]);

export type ServerEvent = z.infer<typeof serverEventSchema>;

/*
 * The caption columns, which every project response carries. They fall back to
 * empty rather than rejecting, so a response from a server that predates them
 * still opens: the editor would otherwise refuse a slideshow over a field the
 * reader has never filled in.
 */
export const captionSchema = z.string().catch("");

// Mirrors the shape toProject returns in server/projects.mjs:148-158, plus the
// caption columns this rewrite added beside name and status.
export const projectSchema = documentSchema.extend({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  status: slideshowStatusSchema,
  description: captionSchema,
  hashtags: captionSchema,
  accountId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** The shape `toProject` returns in server/projects.mjs:148-158. */
export type Project = {
  id: string;
  name: string;
  version: number;
  status: SlideshowStatus;
  /** The caption to post with, as the person or the agent wrote it. */
  description: string;
  /** The tags that go under it, as `#one #two`. */
  hashtags: string;
  accountId: string;
  createdAt: number;
  updatedAt: number;
} & SlideDocument;

/**
 * Parses a project response, repairing rather than rejecting the document
 * portion the same way parseDocument does, including the z back-fill
 * (assignLayerOrder). projectSchema itself is left free of a top-level
 * .catch(): a genuinely malformed API response should still throw here, the
 * way it always has, rather than silently becoming an empty project.
 */
export function parseProject(value: unknown): Project {
  const project = projectSchema.parse(value);
  assignLayerOrder(project);
  return project;
}

// Mirrors toSummary (server/projects.mjs:133-146) plus coverUrl, which
// list() adds afterward by looking the cover item up in the library
// (server/projects.mjs:23-25) rather than toSummary returning it directly.
export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  ratio: ratioSchema,
  status: slideshowStatusSchema,
  description: captionSchema,
  hashtags: captionSchema,
  accountId: z.string(),
  slideCount: z.number(),
  coverItemId: z.string().nullable(),
  coverUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** toSummary's shape (server/projects.mjs:133-146) plus coverUrl, added by list() at server/projects.mjs:23-25. */
export type ProjectSummary = {
  id: string;
  name: string;
  version: number;
  ratio: Ratio;
  status: SlideshowStatus;
  description: string;
  hashtags: string;
  accountId: string;
  slideCount: number;
  coverItemId: string | null;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
};
