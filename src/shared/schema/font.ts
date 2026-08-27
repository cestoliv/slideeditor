import { z } from "zod";

export type FontSource = "builtin" | "google";

export type FontEntry = {
  id: string;
  family: string;
  weight: number;
  /**
   * The full weight axis a variable font's own binary carries, or null for a
   * static face — a builtin with only one instance in its file, or a Google
   * family whose css2 response declared a single weight rather than a range
   * (server/services/fonts.ts's parseWeightDeclaration parses either shape
   * for a Google family, not just a bundled one). Set together or not at
   * all: a face with a range is declared `font-weight: weightMin weightMax`
   * (letting the browser pick a real instance for any weight in between,
   * the same shorthand design/fonts.css's own static declaration uses for
   * the boot-path TikTok Sans face main.tsx imports directly, before this
   * fetched catalogue is available — see that file's own comment); a face
   * with neither is pinned at `weight` the way it always was.
   */
  weightMin: number | null;
  weightMax: number | null;
  source: FontSource;
  /** /media/... for a google family, /fonts/... for a builtin one. */
  url: string;
};

export const fontEntrySchema: z.ZodType<FontEntry> = z
  .object({
    id: z.string(),
    family: z.string(),
    weight: z.number(),
    // .nullish() rather than .nullable(): a response that omits the field
    // entirely (undefined, not null — e.g. an older server, or a payload
    // shaped by hand in a test) must parse too, not fail the whole catalogue
    // fetch. Normalized to null so FontEntry's own type never sees undefined.
    weightMin: z
      .number()
      .nullish()
      .transform((value) => value ?? null),
    weightMax: z
      .number()
      .nullish()
      .transform((value) => value ?? null),
    source: z.enum(["builtin", "google"]),
    url: z.string(),
  })
  // The documented invariant ("set together or not at all") enforced here,
  // rather than defended against wherever a FontEntry is read: a caller can
  // then trust that weightMin and weightMax are never one null and the other
  // a number, instead of re-checking both every time it wants either.
  .refine((entry) => (entry.weightMin === null) === (entry.weightMax === null), {
    message: "weightMin and weightMax must be set together or not at all",
    path: ["weightMin"],
  });

/** The shape of a GET /api/fonts response, before each entry is validated on its own. */
const fontListEnvelopeSchema = z.object({ fonts: z.array(z.unknown()) });

/**
 * One catalogue entry parseFontEntries could not use, kept around rather than
 * only logged: the entry is still dropped (there is no safe value to render
 * or paint with), but a caller that can put a person in front of it — the
 * admin screen, say — needs more than a devtools console nobody has open to
 * learn that a font silently vanished from the picker, with no id left to
 * delete it by, while every slide still naming it quietly renders in a
 * substitute face instead.
 */
export type DroppedFontEntry = {
  /** The entry's own family name, or a positional fallback when even that did not parse. */
  label: string;
  /** The first validation failure, human-readable. */
  issue: string;
};

/**
 * Parses a GET /api/fonts response leniently: one malformed entry is dropped
 * from `fonts` rather than failing the whole catalogue, and reported back in
 * `dropped` rather than only through the console — see DroppedFontEntry's
 * own doc comment for why a log line alone is not enough.
 *
 * `z.array(fontEntrySchema)` used to sit directly on the envelope, so a
 * single bad row failed the parse of the entire array — the catalogue fetch
 * in fontFaces.ts came back with no faces for any family (silently: nothing
 * printed, `loaded` left false so every later probe refetched and failed the
 * same way), and the same parse throws inside AccountsStore.refresh's
 * Promise.all, so the accounts screen reported "Couldn't load accounts."
 * from the very same bad row at the same time. The envelope shape itself
 * (`{ fonts: [...] }`) is still enforced strictly: that is not a per-entry
 * problem, and a response missing it entirely means there is nothing here
 * worth salvaging entry by entry.
 */
export function parseFontEntries(payload: unknown): {
  fonts: FontEntry[];
  dropped: DroppedFontEntry[];
} {
  const envelope = fontListEnvelopeSchema.parse(payload);
  const fonts: FontEntry[] = [];
  const dropped: DroppedFontEntry[] = [];
  for (const [index, raw] of envelope.fonts.entries()) {
    const result = fontEntrySchema.safeParse(raw);
    if (result.success) {
      fonts.push(result.data);
      continue;
    }
    const label =
      typeof raw === "object" &&
      raw !== null &&
      "family" in raw &&
      typeof raw.family === "string"
        ? raw.family
        : `entry ${String(index)}`;
    const issue = result.error.issues[0]?.message ?? "does not match the expected shape";
    console.error(`Skipping malformed font catalogue entry (${label}):`, result.error);
    dropped.push({ label, issue });
  }
  return { fonts, dropped };
}
