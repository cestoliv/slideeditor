import { afterEach, expect, it, vi } from "vitest";
import { fontEntrySchema, parseFontEntries } from "./font.js";

it("parses a builtin font entry", () => {
  const entry = fontEntrySchema.parse({
    id: "f1",
    family: "TikTok Sans",
    weight: 500,
    weightMin: null,
    weightMax: null,
    source: "builtin",
    url: "/fonts/tiktok-sans.woff2",
  });
  expect(entry.source).toBe("builtin");
});

it("parses a google font entry", () => {
  const entry = fontEntrySchema.parse({
    id: "f2",
    family: "Inter",
    weight: 500,
    weightMin: null,
    weightMax: null,
    source: "google",
    url: "/media/abc123.woff2",
  });
  expect(entry.source).toBe("google");
});

// A builtin whose bundled binary is itself a variable font (TikTok Sans)
// carries the axis its @font-face should declare, rather than the single
// pinned weight every static face carries. 300-900 is TikTok Sans's real
// axis (its own fvar table: min 300, default 300, max 900).
it("parses a variable builtin font entry carrying a weight range", () => {
  const entry = fontEntrySchema.parse({
    id: "f1",
    family: "TikTok Sans",
    weight: 500,
    weightMin: 300,
    weightMax: 900,
    source: "builtin",
    url: "/fonts/tiktok-sans.ttf",
  });
  expect(entry.weightMin).toBe(300);
  expect(entry.weightMax).toBe(900);
});

it("rejects an unknown source", () => {
  expect(() =>
    fontEntrySchema.parse({
      id: "f3",
      family: "Inter",
      weight: 500,
      weightMin: null,
      weightMax: null,
      source: "dropbox",
      url: "/media/abc123.woff2",
    }),
  ).toThrow();
});

// weightMin/weightMax must be nullish, not just nullable: a payload can omit
// them entirely (an older server, or a value shaped by hand) rather than
// sending an explicit null, and that must not fail the whole fetch.
it("defaults a missing weight range to null rather than rejecting the entry", () => {
  const entry = fontEntrySchema.parse({
    id: "f4",
    family: "Space Mono",
    weight: 400,
    source: "builtin",
    url: "/fonts/space-mono.ttf",
  });
  expect(entry.weightMin).toBeNull();
  expect(entry.weightMax).toBeNull();
});

// The documented invariant: a range is set together or not at all. Enforced
// in the schema so every reader can trust it rather than re-checking both
// fields for a mismatch itself.
it("rejects a weight range with only one bound set", () => {
  expect(() =>
    fontEntrySchema.parse({
      id: "f5",
      family: "TikTok Sans",
      weight: 500,
      weightMin: 300,
      weightMax: null,
      source: "builtin",
      url: "/fonts/tiktok-sans.ttf",
    }),
  ).toThrow();
});

const VALID_ENTRY = {
  id: "f1",
  family: "TikTok Sans",
  weight: 500,
  weightMin: null,
  weightMax: null,
  source: "builtin",
  url: "/fonts/tiktok-sans.ttf",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("parses every well-formed entry and drops nothing", () => {
  const { fonts, dropped } = parseFontEntries({ fonts: [VALID_ENTRY] });
  expect(fonts).toHaveLength(1);
  expect(dropped).toHaveLength(0);
});

/*
 * Finding 8 (fix round 4): a malformed entry used to be dropped with only a
 * console.warn — a signal nobody watches. It vanished from the admin picker
 * with no id left to delete it by, while any slide still naming it silently
 * fell back to a substitute face, and nothing short of reading server logs
 * would ever surface that. `dropped` is what lets a caller that can put a
 * person in front of it (AccountsStore.refresh(), accounts.tsx) actually do
 * that, instead of only spamming a console.
 */
it("keeps a malformed entry out of fonts, but reports it in dropped rather than only logging it", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const malformed = {
    ...VALID_ENTRY,
    id: "f2",
    family: "Broken Font",
    source: "not-a-source",
  };
  const { fonts, dropped } = parseFontEntries({ fonts: [VALID_ENTRY, malformed] });

  expect(fonts).toHaveLength(1);
  expect(fonts[0]?.family).toBe("TikTok Sans");

  expect(dropped).toHaveLength(1);
  expect(dropped[0]?.label).toBe("Broken Font");
  expect(dropped[0]?.issue).toBeTruthy();
});

it("falls back to a positional label when even the family name did not parse", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { dropped } = parseFontEntries({ fonts: [{ id: "f3" }] });
  expect(dropped).toHaveLength(1);
  expect(dropped[0]?.label).toBe("entry 0");
});
