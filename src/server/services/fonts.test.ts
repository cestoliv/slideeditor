import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  createTestApp,
  addItem,
  asHttpError,
  catchError,
  type TestApp,
} from "../testing.js";
import type { FontEntry } from "../../shared/schema/index.js";
import { DEFAULT_ADVANCE_RATIO } from "../../shared/text/index.js";
import { FontInUseError, FontService } from "./fonts.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

const CSS_FIXTURE = (family: string) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/s/stub/v1/stub.woff2) format('woff2');}`;

// Modelled on what fonts.googleapis.com/css2 actually returns for a
// multi-subset family: one @font-face block per unicode-range, with no
// guaranteed order. The Latin block here is deliberately NOT first, so a
// naive "take the first block" parse would self-host the Cyrillic face.
const MULTI_SUBSET_CSS = (family: string) => `
  @font-face {
    font-family: '${family}';
    font-style: normal;
    font-weight: 400;
    src: url(https://fonts.gstatic.com/s/stub/v1/cyrillic.woff2) format('woff2');
    unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
  }
  @font-face {
    font-family: '${family}';
    font-style: normal;
    font-weight: 400;
    src: url(https://fonts.gstatic.com/s/stub/v1/latin.woff2) format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153;
  }
`;

function extractMediaRef(url: string): { mediaId: string; ext: string } {
  const match = /^\/media\/([^./]+)\.(.+)$/.exec(url);
  if (!match?.[1] || !match[2]) throw new Error(`Not a media url: ${url}`);
  return { mediaId: match[1], ext: match[2] };
}

/**
 * Adds one google-sourced font with the network stubbed, for a test that
 * needs a font it is actually allowed to delete — a builtin is not (see
 * "refuses to delete a builtin font" below). The app must have been built
 * with `fetchCss: async (family) => CSS_FIXTURE(family)`, the way the "adds a
 * google font" test above does.
 */
async function addFont(target: TestApp, family: string) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    return await target.services.fonts.addGoogleFont(family);
  } finally {
    globalThis.fetch = realFetch;
  }
}

it("seeds the builtin catalogue with TikTok Sans and Space Mono", () => {
  app = createTestApp();
  const families = app.services.fonts.list().map((font) => font.family);
  expect(families).toContain("TikTok Sans");
  expect(families).toContain("Space Mono");
  expect(app.services.fonts.list().every((font) => font.source === "builtin")).toBe(true);
});

/*
 * TikTokSans.ttf is itself a variable font: its own fvar table carries a
 * 300-900 wght axis (min 300, default 300, max 900) — the range
 * design/fonts.css's own static @font-face declares too, on the boot path,
 * for the screens before sign-in. Seeding weightMin/weightMax with the real
 * axis here is what would let a dynamically generated @font-face expose it
 * rather than pinning the face to the single weight column (which would make
 * the browser synthesise bold for every design-system weight above it) —
 * except finding 3 makes web/app/fontFaces.ts skip re-declaring this exact
 * family from the fetched catalogue at all, since the static declaration
 * already covers it; weightMin/weightMax stay seeded regardless, both to
 * keep this row descriptor-identical with the static rule and because
 * weightFor() (fontFaces.ts) still reads this row's `weight` column directly.
 * SpaceMono.ttf is a single static instance and carries neither.
 */
it("seeds TikTok Sans with its variable weight range, and Space Mono with none", () => {
  app = createTestApp();
  const fonts = app.services.fonts.list();
  const tikTokSans = fonts.find((font) => font.family === "TikTok Sans");
  const spaceMono = fonts.find((font) => font.family === "Space Mono");
  expect(tikTokSans?.weightMin).toBe(300);
  expect(tikTokSans?.weightMax).toBe(900);
  expect(spaceMono?.weightMin).toBeNull();
  expect(spaceMono?.weightMax).toBeNull();
});

/*
 * Finding 10: the compose engine's line-wrap estimate used to know only two
 * families by name, hardcoded in a shared/text/constants.ts map — a third
 * family, however different its real average glyph width, always got that
 * map's own default. The font table now carries the value per row instead:
 * seedBuiltins reconciles the two builtins to their own hand-tuned values,
 * and advanceRatioFor is what a caller (routes/slideshows.ts,
 * mcp/tools.ts) reads it through.
 */
it("answers each builtin's own advance ratio rather than one shared default", () => {
  app = createTestApp();
  expect(app.services.fonts.advanceRatioFor("TikTok Sans")).toBe(DEFAULT_ADVANCE_RATIO);
  expect(app.services.fonts.advanceRatioFor("Space Mono")).toBe(0.6);
});

it("falls back to the shared default for a family with no measured value", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  await addFont(app, "Space Grotesk");
  // Every Google-added family is unmeasured today — see the `advance`
  // column's own migration comment — so this is DEFAULT_ADVANCE_RATIO, not
  // some other family's tuned value.
  expect(app.services.fonts.advanceRatioFor("Space Grotesk")).toBe(DEFAULT_ADVANCE_RATIO);
});

it("falls back to the shared default for a family with no font row at all", () => {
  app = createTestApp();
  expect(app.services.fonts.advanceRatioFor("Not A Real Font")).toBe(
    DEFAULT_ADVANCE_RATIO,
  );
});

/*
 * The trap that made finding 1's fix a no-op on its own: a database whose
 * font table already holds a TikTok Sans row seeded before weight_min/
 * weight_max existed (every database this branch created until the columns
 * were added as their own migration) keeps that row's columns NULL forever
 * under `INSERT OR IGNORE`, which never updates an existing row. Booting
 * would succeed once the columns exist, but faceRule() would still pin
 * font-weight: 500 — the exact synthesised-bold behaviour this feature set
 * out to fix. seedBuiltins must reconcile (upsert), not just insert-if-absent.
 */
it("reconciles an existing builtin row's weight range instead of leaving it alone", () => {
  app = createTestApp();
  // Simulate a row seeded before weight_min/weight_max were backfilled: null
  // out the columns the constructor above already set, as if this row had
  // survived from before FontService knew about the range at all.
  app.db
    .prepare("UPDATE font SET weight_min = NULL, weight_max = NULL WHERE family = ?")
    .run("TikTok Sans");
  const before = app.services.fonts.list().find((font) => font.family === "TikTok Sans");
  expect(before?.weightMin).toBeNull();
  expect(before?.weightMax).toBeNull();

  // A fresh FontService construction against the same database is what
  // happens on every server restart — this is the reconciliation that must
  // repair the row rather than leaving it alone.
  new FontService({ db: app.db, media: app.services.media });

  const after = app.services.fonts.list().find((font) => font.family === "TikTok Sans");
  expect(after?.weightMin).toBe(300);
  expect(after?.weightMax).toBe(900);
  // The id, source and created_at of the original row are untouched — this
  // is a reconciliation of the row that is there, not a fresh insert.
  expect(after?.id).toBe(before?.id);
});

/*
 * Finding 7 (fix round 3): seedBuiltins's upsert reset weight/weight_min/
 * weight_max/ext on conflict but left source and media_id alone. A family a
 * user had added from Google keeps that row's `family` UNIQUE slot, so if it
 * later collides with a BUILTIN_FONTS entry (same family name), the upsert
 * above ends up overwriting only half the row: weight/ext move to the
 * builtin's own values while source stays 'google' and media_id keeps
 * pointing at the family's self-hosted .woff2. toEntry then builds a
 * /media/<id>.ttf url — the wrong extension for a file that is still a
 * .woff2 — which 404s, and every restart reseeds the same broken row because
 * seedBuiltins runs unconditionally.
 */
it("resets source and media_id too, when a family that was added from Google collides with a builtin", () => {
  app = createTestApp();
  // Simulate a family that was added as a Google font — with its own
  // media_id and woff2 extension — before this database ever saw the
  // builtin definition that happens to share its family name.
  app.db
    .prepare(
      `UPDATE font
       SET source = 'google', media_id = 'stale-media-id', ext = 'woff2'
       WHERE family = ?`,
    )
    .run("TikTok Sans");
  const before = app.services.fonts.list().find((font) => font.family === "TikTok Sans");
  expect(before?.source).toBe("google");
  expect(before?.url).toBe("/media/stale-media-id.woff2");

  // A fresh FontService construction — an ordinary restart — reconciles the
  // row against BUILTIN_FONTS, the same way it repairs weightMin/weightMax.
  new FontService({ db: app.db, media: app.services.media });

  const after = app.services.fonts.list().find((font) => font.family === "TikTok Sans");
  expect(after?.source).toBe("builtin");
  // Resolves through the builtin /fonts/... route, not a media file that
  // does not carry this extension and was never actually re-uploaded.
  expect(after?.url).toBe("/fonts/tiktok-sans.ttf");
  expect(after?.id).toBe(before?.id);
});

/*
 * Finding 7 (fix round 4): the reconciliation above nulls out media_id when
 * a Google-sourced family collides with a builtin, but the .woff2 that
 * media_id pointed at was never cleaned up. remove() refuses to run on a
 * builtin row at all (see remove()'s own doc comment), so once source flips
 * to 'builtin' nothing in this service can ever reach that file again — it
 * sat on disk, unreferenced and undeletable, for the life of the install.
 */
it("cleans up the orphaned self-hosted file when a Google font collides with a builtin", () => {
  app = createTestApp();
  app.db
    .prepare(
      `UPDATE font
       SET source = 'google', media_id = 'stale-media-id', ext = 'woff2'
       WHERE family = ?`,
    )
    .run("TikTok Sans");

  const removed: { mediaId: string; ext: string }[] = [];
  app.services.media.remove = async (mediaId: string, ext: string) => {
    removed.push({ mediaId, ext });
  };

  // A fresh FontService construction — an ordinary restart — is what runs
  // seedBuiltins() and triggers the cleanup.
  new FontService({ db: app.db, media: app.services.media });

  expect(removed).toEqual([{ mediaId: "stale-media-id", ext: "woff2" }]);
});

it("adds a google font with the network fetch stubbed, and is idempotent on family", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
    const first = await app.services.fonts.addGoogleFont("Space Grotesk");
    expect(first).toMatchObject({
      family: "Space Grotesk",
      source: "google",
      weight: 400,
      // This fixture's font-weight is a single static value, so there is no
      // axis to carry. See "adds a google font whose css2 response declares
      // a variable weight range" below for the range case.
      weightMin: null,
      weightMax: null,
    });
    expect(first.url).toMatch(/^\/media\//);

    const second = await app.services.fonts.addGoogleFont("Space Grotesk");
    expect(second.id).toBe(first.id);
    expect(
      app.services.fonts.list().filter((f) => f.family === "Space Grotesk"),
    ).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * Finding 5: Google's css2 endpoint returns a RANGE (`font-weight: 100 900`)
 * for a variable family where it serves the axis rather than one static
 * instance — FONT_FACE_WEIGHT used to take only the first integer, so this
 * was stored as `weight: 100` with `weight_min`/`weight_max` left NULL: a
 * variable family painted hairline everywhere, and every instance but the
 * lowest was unreachable through faceRule() (web/app/fontFaces.ts). Fixed by
 * parsing the range and clamping TEXT_WEIGHT — the same representative
 * weight BUILTIN_FONTS hardcodes for TikTok Sans's own 300-900 axis — into
 * it, while keeping the full range for weight_min/weight_max.
 */
it("adds a google font whose css2 response declares a variable weight range", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({
      fetchCss: async (family) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;src:url(https://fonts.gstatic.com/s/stub/v1/stub.woff2) format('woff2');}`,
    });
    const font = await app.services.fonts.addGoogleFont("Some Variable Family");
    expect(font).toMatchObject({
      family: "Some Variable Family",
      source: "google",
      // TEXT_WEIGHT (500) clamped into the declared 100-900 axis, not the
      // range's lowest number.
      weight: 500,
      weightMin: 100,
      weightMax: 900,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A range whose declared axis does not cover TEXT_WEIGHT (500) clamps to the
// nearest bound instead of picking an unavailable instance.
it("clamps a variable weight range that does not cover TEXT_WEIGHT", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({
      fetchCss: async (family) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:600 900;src:url(https://fonts.gstatic.com/s/stub/v1/stub.woff2) format('woff2');}`,
    });
    const font = await app.services.fonts.addGoogleFont("Some Heavy Family");
    expect(font).toMatchObject({ weight: 600, weightMin: 600, weightMax: 900 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// FONT_FACE_URL only requires https and a .woff2 path, so a css2 response
// naming a face anywhere but Google's own CDN must still be refused before a
// byte of it is downloaded.
it("refuses to download a font URL that is not on Google's font CDN", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0]), { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({
      fetchCss: async (family) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:400;src:url(https://evil.example.com/stub.woff2) format('woff2');}`,
    });
    const error = asHttpError(
      await catchError(() => app?.services.fonts.addGoogleFont("Untrusted Host")),
    );
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/not on Google's font CDN/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Bounds memory against a hostile or misbehaving response, the same role
// LibraryService's MAX_UPLOAD_BYTES plays for an image upload.
it("refuses a font download over the size cap", async () => {
  const realFetch = globalThis.fetch;
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  globalThis.fetch = (async () =>
    new Response(oversized, { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
    const error = asHttpError(
      await catchError(() => app?.services.fonts.addGoogleFont("Too Big")),
    );
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/larger than the 5MB limit/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Finding 2: a family containing a `"` breaks the canvas font shorthand
// (shared/text/constants.ts's textFontString interpolates it unescaped)
// silently — `context.font = <invalid>` is a no-op, not a throw — so the
// wrong-but-safe family never reaches the catalogue at all. Rejected before
// the network fetch, so this needs no fetchCss/fetch stub.
it("refuses a font family name containing a quote", async () => {
  app = createTestApp();
  const error = asHttpError(
    await catchError(() => app?.services.fonts.addGoogleFont('Evil" Family')),
  );
  expect(error.status).toBe(400);
  expect(error.message).toMatch(/quotes or line breaks/);
});

// A raw newline (or CR/FF) breaks the canvas shorthand's quoted string the
// same way a `"` does, so it is refused here too. A backslash is not: see
// FONT_FAMILY_UNSAFE's own comment for why it stays legal (the family in
// "matches a family name containing a backslash..." below relies on it).
it("refuses a font family name containing a raw newline", async () => {
  app = createTestApp();
  const error = asHttpError(
    await catchError(() => app?.services.fonts.addGoogleFont("Evil\nFamily")),
  );
  expect(error.status).toBe(400);
  expect(error.message).toMatch(/quotes or line breaks/);
});

/*
 * byFamily() at the top of addGoogleFont is check-then-act with two awaits
 * (the CSS fetch, the woff2 download) between the check and the INSERT. A
 * double-click, or an agent retrying a slow request, calls this twice before
 * either has reached the INSERT, so both see "not yet added" and both try to
 * insert the same family. Before this was handled, the loser's raw SQLite
 * UNIQUE constraint error surfaced as an unclassified 500 instead of the
 * winner's entry.
 */
it("does not 500 when the same family is added twice concurrently", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([4, 5, 6]), { status: 200 })) as typeof fetch;
  try {
    app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
    const [first, second] = await Promise.all([
      app.services.fonts.addGoogleFont("Space Grotesk"),
      app.services.fonts.addGoogleFont("Space Grotesk"),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      app.services.fonts.list().filter((f) => f.family === "Space Grotesk"),
    ).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * MediaStore is content-addressed, so two concurrent downloads of the exact
 * same bytes already dedupe to one file with no help from FontService — the
 * case worth its own test is two downloads that genuinely differ (a CDN
 * serving slightly different bytes to each request, say), which do produce
 * two distinct files. The loser's own upload is the one that must not be
 * left behind; the winner's must survive untouched.
 */
it("cleans up the loser's own file without touching the winner's, when two concurrent downloads differ", async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  const bytesByCall = [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2, 2])];
  globalThis.fetch = (async () => {
    const bytes = bytesByCall[call] ?? bytesByCall[0]!;
    call += 1;
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
  try {
    app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
    const [first, second] = await Promise.all([
      app.services.fonts.addGoogleFont("Space Grotesk"),
      app.services.fonts.addGoogleFont("Space Grotesk"),
    ]);
    expect(first.id).toBe(second.id);
    const winner = app.services.fonts.list().find((f) => f.family === "Space Grotesk");
    if (!winner) throw new Error("Space Grotesk was not added");
    const { mediaId: winnerMediaId, ext } = extractMediaRef(winner.url);

    // The winner's own file is intact.
    expect(await app.services.media.read(winnerMediaId, ext)).toBeInstanceOf(Buffer);

    // Whichever mediaId lost did not survive as an orphan: the media
    // directory holds exactly the winner's file for this family, not both.
    const winnerHash = createHash("sha256")
      .update(Buffer.from(bytesByCall[0]!))
      .digest("hex");
    const loserHash = createHash("sha256")
      .update(Buffer.from(bytesByCall[1]!))
      .digest("hex");
    const loserMediaId = winnerMediaId === winnerHash ? loserHash : winnerHash;
    await expect(app.services.media.read(loserMediaId, ext)).rejects.toThrow();
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * Finding 7: MediaStore is content-addressed, so two Google families whose
 * downloads happen to be byte-identical (the same underlying font served
 * under two names, or a re-added family) end up pointing at the very same
 * file. remove() used to unlink on the strength of its own row alone, with
 * no count of who else still names that file — deleting one family broke the
 * other's still-advertised /media/<id>.woff2 url.
 */
it("does not delete a media file two fonts still share when one of them is removed", async () => {
  const realFetch = globalThis.fetch;
  const bytes = new Uint8Array([7, 7, 7]);
  globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
  let familyA: FontEntry;
  let familyB: FontEntry;
  try {
    app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
    familyA = await app.services.fonts.addGoogleFont("Family A");
    familyB = await app.services.fonts.addGoogleFont("Family B");
  } finally {
    globalThis.fetch = realFetch;
  }
  const { mediaId, ext } = extractMediaRef(familyA.url);
  expect(extractMediaRef(familyB.url).mediaId).toBe(mediaId);

  app.services.fonts.remove(familyA.id);

  // Family B's row, and the file its url still points at, are both intact —
  // A's removal did not unlink a file B still references.
  expect(app.services.fonts.list().some((f) => f.id === familyB.id)).toBe(true);
  expect(await app.services.media.read(mediaId, ext)).toBeInstanceOf(Buffer);
});

/*
 * Finding 7: the same content-addressed store backs the image library too
 * (media.ts's own comment: "Google fonts are self-hosted through this same
 * content-addressed store"). remove()'s reference count has to look at both
 * tables that can hold a media_id, or a font whose blob a library item
 * happens to share would 404 that item's image the moment the font is
 * deleted.
 */
it("does not delete a media file a library item shares with a removed font", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  const { mediaId, ext } = extractMediaRef(font.url);
  const item = await addItem(
    app.services.library,
    "background",
    "Shares the font's blob",
  );
  // Simulate the library item's own upload having hashed to the exact same
  // bytes as the font's: MediaStore.put() would have deduped them onto one
  // file rather than writing a second copy, which is the real-world shape
  // this reference count exists to survive.
  app.db
    .prepare("UPDATE library_item SET media_id = ? WHERE id = ?")
    .run(mediaId, item.id);

  app.services.fonts.remove(font.id);

  expect(await app.services.media.read(mediaId, ext)).toBeInstanceOf(Buffer);
});

it("picks the Latin subset even when the CSS lists it after other unicode-range blocks", async () => {
  const realFetch = globalThis.fetch;
  const latinBytes = new Uint8Array([9, 9, 9, 9]);
  const cyrillicBytes = new Uint8Array([1, 1, 1, 1]);
  globalThis.fetch = (async (input: unknown) => {
    const requested = String(input);
    const bytes = requested.includes("latin") ? latinBytes : cyrillicBytes;
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
  try {
    app = createTestApp({ fetchCss: async (family) => MULTI_SUBSET_CSS(family) });
    const entry = await app.services.fonts.addGoogleFont("Noto Sans");
    const { mediaId, ext } = extractMediaRef(entry.url);
    const stored = await app.services.media.read(mediaId, ext);
    expect(new Uint8Array(stored)).toEqual(latinBytes);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * COVERS_LATIN used to demand the exact literal entry "U+0+-00FF", so a
 * family whose Latin block is shaped any other way — narrower, or split
 * across more than one entry — matched nothing and 502'd as having "no Latin
 * character set available", even though it plainly serves the Latin alphabet.
 */
it("accepts a Latin block narrower than the full U+0000-00FF entry", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([7, 7, 7]), { status: 200 })) as typeof fetch;
  const narrowLatinCss = (family: string) => `
    @font-face {
      font-family: '${family}';
      font-style: normal;
      font-weight: 400;
      src: url(https://fonts.gstatic.com/s/stub/v1/narrow.woff2) format('woff2');
      unicode-range: U+0020-007F;
    }
  `;
  try {
    app = createTestApp({ fetchCss: async (family) => narrowLatinCss(family) });
    const entry = await app.services.fonts.addGoogleFont("Some Narrow Family");
    expect(entry.family).toBe("Some Narrow Family");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * Finding 5: chooseLatinFace's `find` required unicodeRange to be truthy, so
 * a response mixing an explicitly ranged block (Cyrillic here) with an
 * UNRANGED default block — CSS's own "covers everything not claimed
 * elsewhere" meaning for an absent unicode-range — matched neither the
 * "every block is unranged" shortcut nor the find, and 502'd for a family
 * Google serves fine. The default block is deliberately last, same as the
 * multi-subset fixture above, and is the one this test expects self-hosted.
 */
it("accepts an unranged default block mixed with an explicitly ranged one", async () => {
  const realFetch = globalThis.fetch;
  const defaultBytes = new Uint8Array([6, 6, 6]);
  globalThis.fetch = (async () =>
    new Response(defaultBytes, { status: 200 })) as typeof fetch;
  const mixedCss = (family: string) => `
    @font-face {
      font-family: '${family}';
      font-style: normal;
      font-weight: 400;
      src: url(https://fonts.gstatic.com/s/stub/v1/cyrillic.woff2) format('woff2');
      unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
    }
    @font-face {
      font-family: '${family}';
      font-style: normal;
      font-weight: 400;
      src: url(https://fonts.gstatic.com/s/stub/v1/default.woff2) format('woff2');
    }
  `;
  try {
    app = createTestApp({ fetchCss: async (family) => mixedCss(family) });
    const entry = await app.services.fonts.addGoogleFont("Some Mixed Family");
    const { mediaId, ext } = extractMediaRef(entry.url);
    const stored = await app.services.media.read(mediaId, ext);
    expect(new Uint8Array(stored)).toEqual(defaultBytes);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("accepts a Latin block Google split across more than one unicode-range entry", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([8, 8, 8]), { status: 200 })) as typeof fetch;
  const splitLatinCss = (family: string) => `
    @font-face {
      font-family: '${family}';
      font-style: normal;
      font-weight: 400;
      src: url(https://fonts.gstatic.com/s/stub/v1/split.woff2) format('woff2');
      unicode-range: U+0000-007F,U+0080-00FF;
    }
  `;
  try {
    app = createTestApp({ fetchCss: async (family) => splitLatinCss(family) });
    const entry = await app.services.fonts.addGoogleFont("Some Split Family");
    expect(entry.family).toBe("Some Split Family");
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("stores the weight the chosen @font-face block actually declares, not a hardcoded 400", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([2, 2, 2]), { status: 200 })) as typeof fetch;
  const css600 = (family: string) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:600;src:url(https://fonts.gstatic.com/s/stub/v1/semibold.woff2) format('woff2');}`;
  try {
    app = createTestApp({ fetchCss: async (family) => css600(family) });
    const entry = await app.services.fonts.addGoogleFont("Some Semibold Family");
    expect(entry.weight).toBe(600);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("asks Google for the app's rendering weight first, falling back to the family's regular face", async () => {
  const realFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const requested = String(input);
    if (requested.includes("fonts.googleapis.com")) {
      requestedUrls.push(requested);
      // This family has no 500 weight, so the preferred request is rejected
      // and only the fallback to :wght@400 should succeed.
      if (requested.includes("wght@500")) return new Response("", { status: 400 });
      return new Response(CSS_FIXTURE("No Five Hundred"), { status: 200 });
    }
    return new Response(new Uint8Array([3, 3, 3]), { status: 200 });
  }) as typeof fetch;
  try {
    // No fetchCss override: exercises the real default, which builds the
    // Google URL and does the weight fallback this finding is about.
    app = createTestApp();
    const entry = await app.services.fonts.addGoogleFont("No Five Hundred");
    expect(requestedUrls.some((url) => url.includes("wght@500"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("wght@400"))).toBe(true);
    expect(entry.weight).toBe(400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("computes the /fonts/... url for a builtin family from its own slug logic", () => {
  app = createTestApp();
  const tikTokSans = app.services.fonts.list().find((f) => f.family === "TikTok Sans");
  expect(tikTokSans?.url).toBe("/fonts/tiktok-sans.ttf");
  const spaceMono = app.services.fonts.list().find((f) => f.family === "Space Mono");
  expect(spaceMono?.url).toBe("/fonts/space-mono.ttf");
});

it("rejects a family Google Fonts has never heard of", async () => {
  app = createTestApp({
    fetchCss: async () => {
      throw new Error("Google Fonts had no such family.");
    },
  });
  await expect(app.services.fonts.addGoogleFont("Not A Real Font")).rejects.toThrow();
});

it("refuses to delete a font a stored account default still names", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  app.services.accounts.create({
    name: "Uses Space Grotesk",
    defaults: {
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "Space Grotesk",
        size: 48,
        style: "plain",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    },
  });
  expect(() => app?.services.fonts.remove(font.id)).toThrow(FontInUseError);
});

/*
 * Finding 11: FontInUseError never set `this.name`, unlike
 * AccountNotEmptyError (accounts.ts) — so it logged and serialised as a bare
 * "Error" instead of naming itself, the way every other custom error in this
 * codebase does.
 */
it("names itself FontInUseError rather than a bare Error", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  app.services.accounts.create({
    name: "Uses Space Grotesk",
    defaults: {
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "Space Grotesk",
        size: 48,
        style: "plain",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    },
  });
  const error = await catchError(() => app?.services.fonts.remove(font.id));
  expect(error).toBeInstanceOf(FontInUseError);
  expect((error as Error).name).toBe("FontInUseError");
});

it("removes an unused font", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  app.services.fonts.remove(font.id);
  expect(app.services.fonts.list().some((f) => f.id === font.id)).toBe(false);
});

/*
 * Finding 4: the in-use scan hands every slide's raw JSON to json_each() with
 * no guard on its shape. A slide that is not an object, or whose `texts` is
 * not an array, used to make SQLite raise "malformed JSON" — a bare
 * ERR_SQLITE_ERROR, neither HttpError nor ComposeError — which broke every
 * font deletion, not just the one on the malformed row. The row is written
 * directly rather than through ProjectService, since normalizeDocument now
 * filters a non-object slide out on write (see there) — this proves the read
 * side tolerates a row that predates that filter, or reached the table by
 * some other path.
 */
it("does not break on a stored project whose slide is not an object", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  const now = Date.now();
  app.db
    .prepare(
      `INSERT INTO project (id, name, document, version, status, description, hashtags, account_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'draft', '', '', 'default', ?, ?)`,
    )
    .run(
      "malformed-slide",
      "Malformed",
      JSON.stringify({ ratio: { w: 9, h: 16 }, slides: ["x"] }),
      now,
      now,
    );
  expect(() => app?.services.fonts.remove(font.id)).not.toThrow();
  expect(app.services.fonts.list().some((f) => f.id === font.id)).toBe(false);
});

it("does not break on a stored project whose slide's texts is not an array", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  const now = Date.now();
  app.db
    .prepare(
      `INSERT INTO project (id, name, document, version, status, description, hashtags, account_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'draft', '', '', 'default', ?, ?)`,
    )
    .run(
      "malformed-texts",
      "Malformed texts",
      JSON.stringify({
        ratio: { w: 9, h: 16 },
        slides: [{ id: "s1", backgroundItemId: null, texts: "nope", overlays: [] }],
      }),
      now,
      now,
    );
  expect(() => app?.services.fonts.remove(font.id)).not.toThrow();
});

/*
 * Finding 15: the in-use scan used to be a LIKE '%"fontFamily":"X"%' over the
 * project's whole document TEXT. It reads slides[].texts[].fontFamily through
 * SQLite's own JSON functions now, so this exercises the one shape a naive
 * top-level LIKE could never have matched at all: the family sits nested
 * inside a slide's texts array, not at the document's own top level.
 */
it("refuses to delete a font a stored project's slide still names", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");
  const background = await addItem(app.services.library, "background", "Background");
  const project = app.services.projects.create({
    accountId: "default",
    name: "Uses Space Grotesk",
    document: {
      ratio: { w: 9, h: 16 },
      slides: [
        {
          id: "s1",
          backgroundItemId: background.id,
          texts: [{ id: "t1", fontFamily: "Space Grotesk" }],
          overlays: [],
        },
      ],
    },
  });
  const error = await catchError(() => app?.services.fonts.remove(font.id));
  const inUse = error instanceof FontInUseError ? error : null;
  expect(inUse).not.toBeNull();
  expect(inUse?.usedBy).toContain(project.name);
});

/*
 * Finding 15: the LIKE scan escaped `%`/`_` for its own SQL wildcard syntax,
 * but a family's backslash is JSON-escaped (`\\`) inside the stored document
 * — a different escaping convention than the needle's LIKE-escaping, so the
 * two never lined up and an in-use font could be deleted out from under a
 * slide still naming it. json_extract compares the actual decoded string, so
 * this passes once the family really is matched exactly rather than by text
 * pattern.
 */
it("matches a family name containing a backslash rather than missing it", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const family = String.raw`Weird\Font`;
  const font = await addFont(app, family);
  const background = await addItem(app.services.library, "background", "Background");
  const project = app.services.projects.create({
    accountId: "default",
    name: "Uses Weird Font",
    document: {
      ratio: { w: 9, h: 16 },
      slides: [
        {
          id: "s1",
          backgroundItemId: background.id,
          texts: [{ id: "t1", fontFamily: family }],
          overlays: [],
        },
      ],
    },
  });
  const error = await catchError(() => app?.services.fonts.remove(font.id));
  const inUse = error instanceof FontInUseError ? error : null;
  expect(inUse).not.toBeNull();
  expect(inUse?.usedBy).toContain(project.name);
});

/*
 * remove()'s own comment calls the file unlink "best-effort", but
 * `void this.media.remove(...)` had no rejection handler. MediaStore.remove
 * rethrows anything that is not ENOENT, so a real-world EACCES or EPERM
 * became an unhandled rejection — which, outside a test harness, crashes the
 * whole Node process. DELETE /api/fonts/:id would 200 to the request and then
 * take the server down. This is not best-effort until the rejection actually
 * goes nowhere.
 */
it("does not let a failed file unlink escape as an unhandled rejection", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "Space Grotesk");

  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  app.services.media.remove = () => Promise.reject(failure);

  const realConsoleError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    // Synchronous by contract, so nothing here awaits the failing unlink.
    // If it were left unhandled, vitest would report this as an unhandled
    // rejection once the microtask below lets it settle.
    expect(() => app?.services.fonts.remove(font.id)).not.toThrow();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    console.error = realConsoleError;
  }

  // The database row is still gone even though the file cleanup failed —
  // that half of "best effort" already worked.
  expect(app.services.fonts.list().some((f) => f.id === font.id)).toBe(false);
  // And the failure went somewhere rather than vanishing silently.
  expect(logged).toEqual([[failure]]);
});

/*
 * A deleted builtin does not stay deleted: seedBuiltins() re-inserts anything
 * missing on the very next construction. Deleting one anyway would let
 * remove() answer 200 to a request that silently reverts on restart, so
 * builtins are refused rather than accepted and undone later.
 */
it("refuses to delete a builtin font", async () => {
  app = createTestApp();
  const font = app.services.fonts.list().find((f) => f.family === "Space Mono");
  if (!font) throw new Error("Space Mono was not seeded");

  const error = asHttpError(await catchError(() => app?.services.fonts.remove(font.id)));
  expect(error.status).toBe(400);
  expect(error.message).toContain("Space Mono");

  expect(app.services.fonts.list().some((f) => f.id === font.id)).toBe(true);
});

/*
 * "%" and "_" are SQLite LIKE wildcards. Before finding 15 replaced the scan
 * with json_extract equality, a family name containing either used to
 * over-match: an account naming an unrelated family that merely fit the
 * pattern (e.g. "AXB" against a needle built from "A_B") would read as "still
 * in use" and block a deletion that was perfectly safe. json_extract compares
 * the decoded string exactly, so this is no longer even a LIKE query — kept
 * as a regression guard against either implementation over-matching.
 */
it("does not let a family name's own % or _ wrongly over-match a search", async () => {
  app = createTestApp({ fetchCss: async (family) => CSS_FIXTURE(family) });
  const font = await addFont(app, "A_B");
  // A real, separately-added family — finding 13 requires an account
  // default to name a font this installation actually has, so the account
  // below needs "AXB" to genuinely exist rather than merely resemble "A_B"
  // under the old LIKE-wildcard semantics this test guards against.
  await addFont(app, "AXB");
  app.services.accounts.create({
    name: "Uses an unrelated family",
    defaults: {
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "AXB",
        size: 48,
        style: "plain",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    },
  });

  expect(() => app?.services.fonts.remove(font.id)).not.toThrow();
  expect(app.services.fonts.list().some((f) => f.id === font.id)).toBe(false);
});
