import { z } from "zod";
import { normalizeHexColor, normalizeTextBackground } from "../geometry/color.js";
import {
  DEFAULT_RATIO,
  RATIO_ASPECT_MAX,
  RATIO_ASPECT_MIN,
  ratioSchema,
} from "./document.js";
import type { Ratio } from "./document.js";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_MAX_TEXT_WIDTH,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MAX_TEXT_WIDTH_MAX,
  MAX_TEXT_WIDTH_MIN,
} from "../text/constants.js";

/**
 * The account every pre-existing slideshow and library item is backfilled
 * into (migration 6's seed row), and the account a fresh install starts with.
 */
export const DEFAULT_ACCOUNT_ID = "default";

export type AccountDefaults = {
  ratio: Ratio;
  text: {
    fontFamily: string;
    size: number;
    style: "plain" | "outline" | "boxed";
    color: string;
    /** A hex colour. normalizeTextBackground still accepts the two legacy
     * tone names, "white" and "black", case-insensitively. */
    background: string;
    backgroundShape: "lines" | "full";
    align: "left" | "center" | "right";
    maxWidth: number;
  };
};

export type Account = {
  id: string;
  name: string;
  defaults: AccountDefaults;
  createdAt: number;
  updatedAt: number;
};

/**
 * composeDocument's normalizeRatio (shared/compose/compose.ts) throws outside
 * this same [RATIO_ASPECT_MIN, RATIO_ASPECT_MAX] window, so an account whose
 * default ratio sat outside it used to save successfully and then 400 on
 * every later create_slideshow/save that omitted its own ratio — a
 * constraint the account endpoint never enforced. Rejecting it here, at the
 * same boundary compose already draws, closes that gap instead of letting an
 * account exist that no write can ever use.
 */
const boundedRatioSchema = ratioSchema.refine(
  (ratio) => {
    const aspect = ratio.w / ratio.h;
    return aspect >= RATIO_ASPECT_MIN && aspect <= RATIO_ASPECT_MAX;
  },
  {
    message: `Keep the ratio between ${String(RATIO_ASPECT_MIN)}:1 and ${String(RATIO_ASPECT_MAX)}:1.`,
  },
);

/**
 * text.size used to be a bare `z.number().catch(64)`, so a size of 0 or
 * negative was silently accepted and never errored — it just composed
 * invisible or upside-down text forever (textHeight() divides by size).
 * Unlike ratio, size has no downstream throw to catch this, so it must be
 * rejected here, at the same [FONT_SIZE_MIN, FONT_SIZE_MAX] window the
 * editor's own slider already enforces (fontSize.ts).
 */
const boundedSizeSchema = z
  .number()
  .min(FONT_SIZE_MIN, `Text size must be at least ${String(FONT_SIZE_MIN)}.`)
  .max(FONT_SIZE_MAX, `Text size must be at most ${String(FONT_SIZE_MAX)}.`);

/**
 * A fraction of the frame width, not a percent integer, because that is what
 * compose.ts and newTextLayer both consume directly — a text layer's own
 * `width` is already a fraction, so storing one here means neither has to
 * convert on the way in. Only the account admin field speaks percent, and it
 * converts at the edge.
 *
 * `.default` rather than `.catch`, the same reject-do-not-coerce stance
 * boundedSizeSchema takes: a legacy account row saved before this field
 * existed has no `maxWidth` key at all, and `.default` fills that gap with
 * DEFAULT_MAX_TEXT_WIDTH while still rejecting a present-but-out-of-range
 * value rather than silently clamping it the way `.catch` would.
 */
const boundedMaxWidthSchema = z
  .number()
  .min(
    MAX_TEXT_WIDTH_MIN,
    `Text width must be at least ${String(MAX_TEXT_WIDTH_MIN * 100)}%.`,
  )
  .max(
    MAX_TEXT_WIDTH_MAX,
    `Text width must be at most ${String(MAX_TEXT_WIDTH_MAX * 100)}%.`,
  )
  .default(DEFAULT_MAX_TEXT_WIDTH);

/**
 * text.color used to be a bare z.string(), so "not-a-color" was stored
 * verbatim: neither CSS nor the canvas paint path errors on it, they just
 * silently ignore it and fall back to no colour at all, with nothing telling
 * anyone. normalizeHexColor (geometry/color.ts) is the same acceptance rule
 * every other colour in this app is already held to (3- or 6-digit hex, with
 * or without a leading #) — reused here rather than a second regex, so this
 * schema and that function can never drift on what counts as valid. Rejects
 * rather than silently coercing, the same way boundedSizeSchema does, and
 * normalizes what it accepts (uppercased, # added, 3-digit expanded) so a
 * later exact-string comparison never sees two spellings of the same colour.
 */
const hexColorSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeHexColor(value);
  if (normalized === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enter a hex colour, e.g. #FFFFFF.",
    });
    return z.NEVER;
  }
  return normalized;
});

export const accountDefaultsSchema: z.ZodType<AccountDefaults, unknown> = z.object({
  ratio: boundedRatioSchema,
  text: z.object({
    // fontFamily's other natural check — that the name is one this
    // installation actually knows about, i.e. a row in the font table — is
    // enforced server-side (services/accounts.ts), not here: this schema is
    // shared code with no database to check against (src/shared must never
    // import from src/server).
    fontFamily: z.string().catch(DEFAULT_FONT_FAMILY),
    size: boundedSizeSchema,
    style: z.enum(["plain", "outline", "boxed"]).catch("plain"),
    color: hexColorSchema,
    // Same treatment as textBackgroundSchema (document.ts): widened from a
    // "white"|"black" enum to any hex colour, silently repaired rather than
    // rejected like color above, since a bad background used to fall back
    // rather than 400.
    background: z
      .string()
      .catch("")
      .transform((value) => normalizeTextBackground(value)),
    backgroundShape: z.enum(["lines", "full"]).catch("lines"),
    align: z.enum(["left", "center", "right"]).catch("center"),
    maxWidth: boundedMaxWidthSchema,
  }),
});

export const accountSchema: z.ZodType<Account> = z.object({
  id: z.string(),
  name: z.string(),
  defaults: accountDefaultsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * The look every slide had before accounts existed. Migration 6 seeds the
 * 'default' account with this exact JSON, so an existing install renders
 * unchanged the moment it upgrades.
 */
export const BUILTIN_DEFAULTS: AccountDefaults = {
  ratio: { ...DEFAULT_RATIO },
  text: {
    fontFamily: DEFAULT_FONT_FAMILY,
    size: 64,
    style: "plain",
    color: "#FFFFFF",
    background: "#FFFFFF",
    backgroundShape: "lines",
    align: "center",
    maxWidth: DEFAULT_MAX_TEXT_WIDTH,
  },
};
