import { z } from "zod";

// Matches KINDS in server/library.mjs:4 and SORTS in server/library.mjs:6.
export const libraryKindSchema = z.enum(["background", "asset"]);
// list() falls back to "recent" on an unknown sort (server/library.mjs:43)
// rather than rejecting it, so this schema repairs the same way.
export const librarySortSchema = z
  .enum(["recent", "least-used", "most-used"])
  .catch("recent");

// Cumulative across a library item's lifetime: a deleted slideshow does not
// reset an item's history. Mirrors the STATS_JOIN in server/library.mjs:9-17.
export const libraryStatsSchema = z.object({
  timesUsed: z.number().catch(0),
  slideshowCount: z.number().catch(0),
  firstUsedAt: z.number().nullable().catch(null),
  lastUsedAt: z.number().nullable().catch(null),
});

const fraction = z.number().min(0).max(1);

/**
 * Where a background leaves room for text, written by an agent that looked at
 * the image. Every value is a fraction of the image, not of the slide, so one
 * note holds for every ratio and crop the background is used at.
 */
export const layoutHintsSchema = z
  .object({
    freeZone: z.enum(["top", "middle", "bottom"]).optional(),
    subject: z
      .object({ x: fraction, y: fraction, w: fraction, h: fraction })
      .strict()
      .refine((box) => box.x + box.w <= 1 && box.y + box.h <= 1, {
        message: "The subject has to sit inside the image.",
      })
      .optional(),
  })
  .strict();

// Mirrors toItem in server/library.mjs:179-201.
export const libraryItemSchema = z.object({
  id: z.string(),
  kind: libraryKindSchema,
  name: z.string(),
  description: z.string().catch(""),
  usage: z.string().catch(""),
  tags: z.array(z.string()).catch([]),
  accountId: z.string(),
  mediaId: z.string(),
  ext: z.string(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  stats: libraryStatsSchema,
  layoutHints: layoutHintsSchema.optional().catch(undefined),
});

/*
 * A slideshow that names a library item. Both halves of the wire need it: the
 * server answers `usedBy` and `brokeSlideshows` with it, and the client parses
 * both. It lives here so a renamed field is a type error rather than a frame
 * the client silently drops.
 */
export const libraryUseSchema = z.object({ id: z.string(), name: z.string() });

export type LibraryUse = z.infer<typeof libraryUseSchema>;

export type LibraryKind = z.infer<typeof libraryKindSchema>;
export type LibrarySort = z.infer<typeof librarySortSchema>;
export type LibraryStats = z.infer<typeof libraryStatsSchema>;
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type LayoutHints = z.infer<typeof layoutHintsSchema>;
