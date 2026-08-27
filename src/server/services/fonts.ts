import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FontEntry, FontSource } from "../../shared/schema/index.js";
import { DEFAULT_ADVANCE_RATIO, TEXT_WEIGHT } from "../../shared/text/index.js";
import { integer, optionalInteger, optionalNumber, text, type Row } from "../db/rows.js";
import { HttpError } from "../errors.js";
import type { MediaStore } from "./media.js";

/** Thrown by remove() when an account default or a stored text layer still names the family. */
export class FontInUseError extends Error {
  readonly usedBy: string[];
  constructor(family: string, usedBy: string[]) {
    super(
      `${family} is still used by ${String(usedBy.length)} account${usedBy.length === 1 ? "" : "s"} or slideshow${usedBy.length === 1 ? "" : "s"}.`,
    );
    this.name = "FontInUseError";
    this.usedBy = usedBy;
  }
}

export interface FontServiceDeps {
  db: DatabaseSync;
  media: MediaStore;
  /** Injected so a test can stub the network without reaching Google. */
  fetchCss?: (family: string) => Promise<string>;
}

/**
 * The curated set shipped with the app, seeded idempotently by every
 * construction. Deliberately just these two: TikTok Sans is the brand
 * default, and Space Mono exists only so there is a second, metrically
 * distinct bundled face for the parity fixture (Task 11) to catch a font
 * string drifting between the measuring canvas and the paint path. Editorial
 * breadth — a grotesk, a serif, a condensed face, a display face — comes from
 * Google Fonts on demand instead of four more bundled binaries: it covers far
 * more of what an account might want, and it avoids shipping files under
 * licence terms this repo would otherwise have to track one by one.
 *
 * TikTokSans.ttf is itself a variable font: its own fvar table carries a
 * 300-900 wght axis (min 300, default 300, max 900 — also its OS/2
 * usWeightClass), read directly off the bundled binary. design/fonts.css,
 * which is on the boot path (main.tsx imports it directly, so the builtin
 * face is there before sign-in — see that file's own comment), used to
 * declare font-weight: 100 900, but that range was already wrong: the
 * binary has no 100-299 instances to serve. It now declares 300 900,
 * matching weightMin/weightMax here exactly — the two must be kept in sync
 * by hand, since fonts.css is a static declaration this seed cannot reach,
 * and web/app/fontFaces.ts skips re-declaring this exact family from the
 * fetched catalogue for the same reason (see its own comment). SpaceMono.ttf
 * is a single static instance, so it carries neither and stays pinned at its
 * one weight, same as every self-hosted Google face.
 */
const BUILTIN_FONTS: readonly {
  family: string;
  weight: number;
  weightMin: number | null;
  weightMax: number | null;
  ext: string;
  /**
   * The two hand-tuned values that used to live in shared/text/constants.ts's
   * own two-entry FONT_ADVANCE_RATIO map, keyed by family name. Reconciled
   * into the font table's own `advance` column below (see that column's own
   * comment) so a third family with a measured value has somewhere to carry
   * it that is not another hardcoded name in that map.
   */
  advance: number;
}[] = [
  {
    family: "TikTok Sans",
    weight: 500,
    weightMin: 300,
    weightMax: 900,
    ext: "ttf",
    advance: DEFAULT_ADVANCE_RATIO,
  },
  {
    family: "Space Mono",
    weight: 400,
    weightMin: null,
    weightMax: null,
    ext: "ttf",
    // A wider monospace face than TikTok Sans — see DEFAULT_ADVANCE_RATIO's
    // own comment for why this needed tuning apart from it in the first place.
    advance: 0.6,
  },
];

/**
 * The on-disk stem for a builtin's bundled file (TikTokSans.ttf,
 * SpaceMono.ttf): its family with the spaces stripped, case preserved. Not
 * an independent value — package.json's own `files` list names exactly
 * these two paths — so this stays a transform of BUILTIN_FONTS rather than a
 * third hardcoded copy of the same two strings.
 */
function fileStem(family: string): string {
  return family.replace(/\s+/g, "");
}

/**
 * Reverses slug() (below): given the slug routes/fonts.ts's /fonts/:file
 * received in the URL, finds the builtin catalogue entry it names and
 * returns the actual file to read off disk. Previously routes/fonts.ts kept
 * its own `known` map from slug back to filename, a second copy of
 * BUILTIN_FONTS' two family names that a new builtin could add without
 * updating — this derives the same answer from the one array both this
 * module and toEntry()'s forward slug(family) already read.
 */
export function builtinFontFileName(requestedSlug: string): string | null {
  const font = BUILTIN_FONTS.find((entry) => slug(entry.family) === requestedSlug);
  return font ? `${fileStem(font.family)}.${font.ext}` : null;
}

const GOOGLE_FONTS_CSS_URL = "https://fonts.googleapis.com/css2";
// A modern desktop UA, so Google serves WOFF2 rather than a legacy format it
// hands a user agent it does not recognise.
const GOOGLE_FONTS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Every outbound font fetch — the CSS lookup and the binary download — dies by here rather than hanging the request forever on a stalled upstream. */
const FONT_FETCH_TIMEOUT_MS = 10_000;

/** A generous ceiling for one self-hosted face. Real WOFF2 files run well under 1MB; this only exists to bound memory against a hostile or misbehaving response, the same role LibraryService's MAX_UPLOAD_BYTES plays for an image. */
const MAX_FONT_BYTES = 5 * 1024 * 1024;

/**
 * The only host addGoogleFont will ever download bytes from. FONT_FACE_URL
 * already requires https and a .woff2 path, but neither constrains which
 * host serves it — a css2 response is trusted input only in the sense that
 * it comes from Google's own CSS endpoint; nothing stops a `src: url(...)`
 * inside it (or a fetchCss test double, or a future bug) from naming
 * anywhere else.
 */
const ALLOWED_FONT_HOST = "fonts.gstatic.com";

// Google's css2 endpoint returns one @font-face block per unicode-range
// subset (latin, latin-ext, cyrillic, vietnamese, greek, ...) for most
// families, in no particular order. Every block is parsed and the one whose
// range covers basic Latin is chosen, rather than trusting the first block in
// the response — grabbing an arbitrary one can self-host a face containing
// only (say) Cyrillic, which fails silently: every Latin character just
// renders in a fallback font.
const FONT_FACE_BLOCK = /@font-face\s*{([^}]*)}/g;
const FONT_FACE_URL = /url\((https:\/\/[^)]+\.woff2)\)/;
/**
 * A static face's `font-weight` is one number; a variable family's is a
 * space-separated RANGE (`font-weight: 100 900;`), the same shorthand
 * BUILTIN_FONTS' own `weight_min`/`weight_max` columns exist to carry for
 * TikTok Sans. The second group is optional so a single-weight face still
 * matches, same as before.
 */
const FONT_FACE_WEIGHT = /font-weight:\s*(\d+)(?:\s+(\d+))?/;
const FONT_FACE_UNICODE_RANGE = /unicode-range:\s*([^;]+);/;
const UNICODE_RANGE_ENTRY = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i;

/**
 * "Latin" here means the printable ASCII block, U+0020-007F: the letters,
 * digits and punctuation any actual sentence needs. Not all of Basic Latin
 * (which starts at U+0000, control characters this app never renders) and
 * not Latin-1 (which reaches U+00FF, a supplement block no family has to
 * serve to be usable here) — requiring either would reject a family that
 * legitimately serves only U+0020-007F.
 */
const LATIN_RANGE_START = 0x20;
const LATIN_RANGE_END = 0x7f;

function parseUnicodeRangeEntry(entry: string): [number, number] | null {
  const match = UNICODE_RANGE_ENTRY.exec(entry.trim());
  if (!match?.[1]) return null;
  const start = Number.parseInt(match[1], 16);
  const end = match[2] ? Number.parseInt(match[2], 16) : start;
  return [start, end];
}

/**
 * Whether a face's unicode-range property, taken as a whole, covers every
 * codepoint in LATIN_RANGE_START-LATIN_RANGE_END — not whether any single
 * comma-separated entry inside it, read on its own, spells out that exact
 * range. Google's css2 endpoint does not always send Latin as one entry: a
 * real response can split it as U+0000-007F,U+0080-00FF, and a family can
 * legitimately serve a narrower U+0020-007F by itself. A literal-string match
 * against one hardcoded entry rejected both as having "no Latin character
 * set available".
 */
function coversLatin(unicodeRange: string): boolean {
  const covered = new Array<boolean>(LATIN_RANGE_END - LATIN_RANGE_START + 1).fill(false);
  for (const entry of unicodeRange.split(",")) {
    const range = parseUnicodeRangeEntry(entry);
    if (!range) continue;
    const [start, end] = range;
    const from = Math.max(start, LATIN_RANGE_START);
    const to = Math.min(end, LATIN_RANGE_END);
    for (let codepoint = from; codepoint <= to; codepoint += 1) {
      covered[codepoint - LATIN_RANGE_START] = true;
    }
  }
  return covered.every(Boolean);
}

interface FontFace {
  url: string;
  weight: number;
  weightMin: number | null;
  weightMax: number | null;
}

interface ParsedFace extends FontFace {
  unicodeRange: string | null;
}

/**
 * `weight` is the single instance this app paints at; `weightMin`/`weightMax`
 * carry the full variable axis when the block declares one, otherwise both
 * stay null — the exact shape BUILTIN_FONTS' own weight/weightMin/weightMax
 * columns already use for TikTok Sans.
 *
 * A static face's `font-weight` is one number, and this app has no reason to
 * paint it at anything but that number, so it becomes `weight` unchanged. A
 * variable face's is a RANGE (FONT_FACE_WEIGHT's own comment), and the app
 * still needs exactly one number to paint with — filling that role is what
 * BUILTIN_FONTS' hardcoded `weight: 500` does for TikTok Sans's own 300-900
 * axis — so `weight` becomes TEXT_WEIGHT clamped into the declared range,
 * the same target `defaultFetchCss` above already requests first. Reading
 * only the range's first number for `weight` here (this function's previous
 * behaviour) pinned a variable family at its LOWEST weight instead: for
 * `font-weight: 100 900`, weightFor() (web/app/fontFaces.ts) answered 100 to
 * every render, and faceRule() there declared only `font-weight: 100` since
 * weightMin/weightMax were never populated for a Google face — hairline text
 * everywhere, with the rest of the file's instances unreachable.
 */
function parseWeightDeclaration(body: string): {
  weight: number;
  weightMin: number | null;
  weightMax: number | null;
} {
  const match = FONT_FACE_WEIGHT.exec(body);
  const first = match ? Number(match[1]) : null;
  const second = match?.[2] !== undefined ? Number(match[2]) : null;
  if (first === null) return { weight: TEXT_WEIGHT, weightMin: null, weightMax: null };
  if (second === null) return { weight: first, weightMin: null, weightMax: null };
  const weightMin = Math.min(first, second);
  const weightMax = Math.max(first, second);
  const weight = Math.min(weightMax, Math.max(weightMin, TEXT_WEIGHT));
  return { weight, weightMin, weightMax };
}

function parseFontFaces(css: string): ParsedFace[] {
  const faces: ParsedFace[] = [];
  for (const match of css.matchAll(FONT_FACE_BLOCK)) {
    const body = match[1] ?? "";
    const url = FONT_FACE_URL.exec(body)?.[1];
    if (!url) continue;
    const { weight, weightMin, weightMax } = parseWeightDeclaration(body);
    const unicodeRange =
      FONT_FACE_UNICODE_RANGE.exec(body)?.[1]?.replace(/\s/g, "") ?? null;
    faces.push({ url, weight, weightMin, weightMax, unicodeRange });
  }
  return faces;
}

/**
 * Picks the face this app should self-host: the one covering basic Latin. If
 * no block in the response declares a unicode-range at all, some single-subset
 * families omit it entirely, so the only block there is is used.
 */
function chooseLatinFace(css: string, family: string): FontFace {
  const faces = parseFontFaces(css);
  if (!faces.length)
    throw new HttpError(502, `Could not find a WOFF2 file for ${family}.`);
  // A block with no `unicode-range` at all is not "unranged" in the sense of
  // "covers nothing" — CSS defaults an absent unicode-range to U+0-10FFFF,
  // so it covers Latin (and everything else) same as an explicit range that
  // includes it. This used to require unicodeRange to be truthy, so a
  // response mixing ranged blocks (Cyrillic, Vietnamese, ...) with an
  // unranged default block matched nothing and 502'd for a family Google
  // serves fine. A response where every block is unranged (the doc comment's
  // single-subset case) also falls through to here, matching the first one.
  const latin = faces.find(
    (face) => !face.unicodeRange || coversLatin(face.unicodeRange),
  );
  if (!latin) throw new HttpError(502, `${family} has no Latin character set available.`);
  return latin;
}

async function fetchCssAtWeight(family: string, weight: number): Promise<Response> {
  const url = `${GOOGLE_FONTS_CSS_URL}?family=${encodeURIComponent(family)}:wght@${String(weight)}`;
  return fetch(url, {
    headers: { "User-Agent": GOOGLE_FONTS_USER_AGENT },
    signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
  });
}

/**
 * Cancels a response's body without reading it, for a response this module
 * decided not to use after all (the rejected `preferred` weight below, an
 * error status about to be thrown past). Leaving it unread holds the
 * underlying connection open until Node eventually reclaims it; cancelling
 * releases it immediately. Best-effort: a response with no body, or one
 * already settled, has nothing to cancel.
 */
async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the connection is going away either way.
  }
}

async function defaultFetchCss(family: string): Promise<string> {
  // TEXT_WEIGHT (500) first, so a self-hosted face matches what the DOM and
  // the canvas export both render at instead of getting synthetically
  // emboldened. Not every family ships a 500, so a rejection falls back to
  // the family's regular (400) face, which every family Google recognises at
  // all is guaranteed to have.
  const preferred = await fetchCssAtWeight(family, TEXT_WEIGHT);
  if (preferred.ok) return preferred.text();
  await drain(preferred);
  const regular = await fetchCssAtWeight(family, 400);
  if (!regular.ok) {
    await drain(regular);
    throw new HttpError(502, `Google Fonts had no family named ${family}.`);
  }
  return regular.text();
}

/**
 * A family name reaches a place that cannot escape it, only reject it
 * outright: the canvas `font` shorthand `shared/text/constants.ts`'s
 * textFontString builds (`${weight} ${fontSize}px "${family}"`, interpolated
 * with no escaping at all — unlike `web/app/fontFaces.ts`'s `faceRule`, which
 * escapes the same value for its CSS `@font-face` rule precisely because
 * "nothing about it is guaranteed to be safe"). A family containing a `"` or
 * a raw newline/CR/FF makes that shorthand invalid the same way an unescaped
 * one breaks the CSS string faceRule builds (see escapeCssString's own
 * comment for the newline/CR/FF case), and browsers do not report a bad
 * `font` assignment: `context.font = <invalid>` is silently a no-op, so the
 * canvas keeps whatever face and metrics it already had. `useTextLayout.ts`'s
 * module-level measuring canvas then wraps against the PREVIOUS layer's font,
 * and `render.ts` assigns the same invalid string on a fresh canvas that
 * stays at its 10px sans-serif default — the editor and the export drifting
 * apart from two different wrong answers, exactly what textFontString's own
 * doc comment says it exists to prevent.
 *
 * A backslash is deliberately NOT in this set: it is a legal, already-tested
 * character in a stored family ("matches a family name containing a
 * backslash rather than missing it", finding 15) and does not break the
 * canvas shorthand's quoted-string boundary the way `"` and a raw line break
 * do — only escapeCssString's CSS use of the same value needs to worry about
 * a backslash, which it already does.
 *
 * Rejected here, at the only place a Google family name enters the catalogue,
 * rather than escaped at every place that builds a font string from it: a
 * name that cannot be used safely on the canvas is worth refusing once
 * instead of trusting every future caller to escape correctly for whichever
 * syntax it happens to be building.
 */
const FONT_FAMILY_UNSAFE = /["\n\r\f]/;

/** The one host addGoogleFont will download bytes from — see ALLOWED_FONT_HOST. */
function assertAllowedFontHost(url: string, family: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new HttpError(502, `${family}'s font URL was malformed.`);
  }
  if (hostname !== ALLOWED_FONT_HOST) {
    throw new HttpError(502, `${family}'s font URL was not on Google's font CDN.`);
  }
}

/**
 * Reads a response body up to `maxBytes`, cancelling and rejecting the moment
 * it is exceeded rather than buffering an unbounded body first and checking
 * afterwards — a Content-Length header can be absent or simply wrong, so the
 * limit is enforced against bytes actually received.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(
        502,
        `${label} is larger than the ${String(Math.floor(maxBytes / (1024 * 1024)))}MB limit.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class FontService {
  private readonly db: DatabaseSync;
  private readonly media: MediaStore;
  private readonly fetchCss: (family: string) => Promise<string>;

  constructor({ db, media, fetchCss = defaultFetchCss }: FontServiceDeps) {
    this.db = db;
    this.media = media;
    this.fetchCss = fetchCss;
    this.seedBuiltins();
  }

  /**
   * Reconciles the built-in rows against BUILTIN_FONTS on every construction,
   * rather than inserting only when the family is absent. A plain
   * INSERT OR IGNORE never updates a row that is already there, so a
   * database that seeded TikTok Sans before weight_min/weight_max existed in
   * the font table would keep those columns NULL forever: toEntry would keep
   * reporting no axis, and fontFaces.ts's faceRule() would keep pinning
   * font-weight: 500 instead of declaring the variable font's real range —
   * the exact synthesised-bold behaviour this catalogue exists to avoid.
   *
   * `source` and `media_id` are reset here too, not just weight/ext: a
   * family a user first added from Google (source 'google', media_id
   * pointing at its self-hosted .woff2) later joining BUILTIN_FONTS used to
   * upsert weight/weight_min/weight_max/ext onto that same row while leaving
   * source and media_id untouched, so toEntry kept building a /media/<id>.ttf
   * URL for a file that was actually a .woff2 (or gone, once remove() — see
   * remove()'s own doc comment on why a builtin can't be deleted — would
   * have refused to run on it precisely because source read 'google', not
   * 'builtin'). The family 404s, the editor falls back, and every restart
   * reseeds the same broken row. Every column BUILTIN_FONTS actually
   * describes is now excluded.* here, so upserting a family that changed
   * provenance leaves nothing behind from its previous one — in the
   * database. The .woff2 file that row's old media_id pointed at is a
   * different story: nulling the column drops the only reference to it
   * without freeing it, and remove() refuses to run on a builtin row at all
   * (see remove()'s own doc comment), so nothing else in this service can
   * ever reach that file again once source flips to 'builtin'. The old
   * media_id and ext are read before the upsert overwrites them, and — best
   * effort, the same way remove() itself cleans up a file, logged rather
   * than thrown so one family's stale file cannot stop the rest of boot —
   * the blob is unlinked once the row no longer points at it.
   */
  private seedBuiltins(): void {
    for (const font of BUILTIN_FONTS) {
      const existing = this.db
        .prepare("SELECT media_id, ext FROM font WHERE family = ?")
        .get(font.family) as Row | undefined;
      const orphanedMediaId = existing ? text(existing, "media_id") : "";
      const orphanedExt = existing ? text(existing, "ext") : "";

      this.db
        .prepare(
          `INSERT INTO font (id, family, source, weight, weight_min, weight_max, advance, media_id, ext, created_at)
           VALUES (?, ?, 'builtin', ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (family) DO UPDATE SET
             source = excluded.source,
             weight = excluded.weight,
             weight_min = excluded.weight_min,
             weight_max = excluded.weight_max,
             advance = excluded.advance,
             media_id = excluded.media_id,
             ext = excluded.ext`,
        )
        .run(
          randomUUID(),
          font.family,
          font.weight,
          font.weightMin,
          font.weightMax,
          font.advance,
          font.ext,
          Date.now(),
        );

      if (orphanedMediaId && !this.mediaStillReferenced(orphanedMediaId)) {
        void this.media
          .remove(orphanedMediaId, orphanedExt || "woff2")
          .catch((error: unknown) => {
            console.error(error);
          });
      }
    }
  }

  list(): FontEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM font ORDER BY source ASC, family ASC")
      .all();
    return rows.map((row) => toEntry(row as Row));
  }

  get(id: string): FontEntry | null {
    const row = this.db.prepare("SELECT * FROM font WHERE id = ?").get(id);
    return row ? toEntry(row as Row) : null;
  }

  private byFamily(family: string): FontEntry | null {
    const row = this.db.prepare("SELECT * FROM font WHERE family = ?").get(family);
    return row ? toEntry(row as Row) : null;
  }

  /**
   * The compose engine's line-wrap estimate (shared/compose/compose.ts's
   * layoutTexts) has no font file to measure a family's average glyph width
   * against, so it reads this instead — a real per-family value where one
   * has been measured (both builtins, seeded by seedBuiltins above), the
   * shared default where it has not (every Google-added family today,
   * `advance` NULL — see the `advance` column's own migration comment). A
   * family with no row at all (never added, or removed since) also falls
   * back rather than throwing: whoever calls this already resolved the
   * family from an account's own defaults, and a missing font row is that
   * caller's problem to surface, not this lookup's to refuse over.
   */
  advanceRatioFor(family: string): number {
    const row = this.db
      .prepare("SELECT advance FROM font WHERE family = ?")
      .get(family) as Row | undefined;
    const advance = row ? optionalNumber(row, "advance") : null;
    return advance ?? DEFAULT_ADVANCE_RATIO;
  }

  async addGoogleFont(family: string): Promise<FontEntry> {
    const name = family.trim();
    if (!name) throw new HttpError(400, "A font family name is required.");
    // See FONT_FAMILY_UNSAFE's own comment: a name that cannot be dropped
    // safely into the canvas font shorthand is refused here rather than
    // stored and left to break wrapping wherever it is later read.
    if (FONT_FAMILY_UNSAFE.test(name)) {
      throw new HttpError(400, "A font family name can't contain quotes or line breaks.");
    }
    const existing = this.byFamily(name);
    if (existing) return existing;

    const css = await this.fetchCss(name);
    const face = chooseLatinFace(css, name);
    assertAllowedFontHost(face.url, name);
    const response = await fetch(face.url, {
      signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await drain(response);
      throw new HttpError(502, `Could not download ${name}.`);
    }
    const bytes = await readBounded(response, MAX_FONT_BYTES, `${name}'s font file`);
    const mediaId = await this.media.put(bytes, "woff2");

    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO font (id, family, source, weight, weight_min, weight_max, media_id, ext, created_at)
           VALUES (?, ?, 'google', ?, ?, ?, ?, 'woff2', ?)`,
        )
        .run(id, name, face.weight, face.weightMin, face.weightMax, mediaId, Date.now());
    } catch (error) {
      if (!isUniqueFamilyViolation(error)) throw error;
      // Lost the race: the check above and this INSERT are two awaits apart,
      // so a double-click or an agent's retry can call this twice before
      // either has reached the INSERT, and both see "not yet added". The
      // winner's row is already there, so its entry is returned instead of
      // surfacing the loser's raw constraint error as an unclassified 500.
      const winner = this.byFamily(name);
      if (!winner) throw error;
      // MediaStore is content-addressed, so a genuinely identical download —
      // the common case, the same family fetched the same way — already
      // reused the winner's own file rather than writing a second one, and
      // there is nothing to clean up. Only a mediaId that differs from what
      // the winning row actually references is this attempt's own upload,
      // and only that one is removed.
      if (
        mediaId !== mediaIdFor(this.db, winner.id) &&
        !this.mediaStillReferenced(mediaId)
      ) {
        void this.media.remove(mediaId, "woff2").catch((removalError: unknown) => {
          console.error(removalError);
        });
      }
      return winner;
    }
    const created = this.get(id);
    if (!created) throw new Error("The font row just inserted has vanished.");
    return created;
  }

  remove(id: string): void {
    const entry = this.get(id);
    if (!entry) throw new HttpError(404, `No font with id ${id}.`);
    // seedBuiltins() re-inserts a missing builtin on every construction, so a
    // "deleted" TikTok Sans or Space Mono would silently come back on the
    // next restart while every reference to it in between resolved to
    // nothing. Refusing here is honest about what a builtin actually is:
    // shipped with the app, not owned by this table.
    if (entry.source === "builtin") {
      throw new HttpError(
        400,
        `${entry.family} is a built-in font and cannot be deleted.`,
      );
    }
    // A LIKE scan over the raw JSON text used to sit here: unindexable,
    // O(total stored bytes) per delete, dependent on exact key spacing, and
    // wrong for a family containing a backslash (LIKE-escaped one way,
    // JSON-escaped another, so the needle missed and an in-use font could be
    // deleted out from under a slide still naming it). SQLite's own JSON
    // functions read the actual structure instead: an account's default is a
    // single scalar at $.text.fontFamily, while a project's document nests
    // fontFamily inside each slide's texts array, so that side needs
    // json_each to walk both levels before comparing.
    const accountRows = this.db
      .prepare(
        `SELECT name FROM account
         WHERE json_valid(defaults)
           AND json_extract(defaults, '$.text.fontFamily') = ?`,
      )
      .all(entry.family) as Row[];
    // Each json_each() argument is guarded by its own json_valid()/json_type()
    // CASE rather than trusting the shape: normalizeDocument only ever checks
    // that `slides` is an array (see there — a slide, or a slide's `texts`,
    // can still be anything), and a row written before that check existed, or
    // by a path that skips it, can carry a slide that is not an object or a
    // `texts` that is not an array. Handing json_each a value it cannot walk
    // throws a raw SQLITE_ERROR ("malformed JSON") that is neither HttpError
    // nor ComposeError, which used to take down every font deletion, not just
    // the one on the malformed row — the ELSE '[]' branch turns "can't walk
    // this" into "found nothing here" instead, for that row alone.
    //
    // json_each's `value` column is already de-quoted for a JSON string
    // element (`"x"` reads back as the bare text `x`), which is not valid
    // JSON on its own — so the guard on slide.value must check json_valid()
    // before json_type(), not only on the document and slides array above.
    const projectRows = this.db
      .prepare(
        `SELECT DISTINCT project.name AS name
         FROM project,
              json_each(
                CASE
                  WHEN json_valid(project.document)
                       AND json_type(project.document, '$.slides') = 'array'
                  THEN json_extract(project.document, '$.slides')
                  ELSE '[]'
                END
              ) AS slide,
              json_each(
                CASE
                  WHEN json_valid(slide.value)
                       AND json_type(slide.value) = 'object'
                       AND json_type(slide.value, '$.texts') = 'array'
                  THEN json_extract(slide.value, '$.texts')
                  ELSE '[]'
                END
              ) AS txt
         WHERE json_valid(txt.value)
           AND json_extract(txt.value, '$.fontFamily') = ?`,
      )
      .all(entry.family) as Row[];
    const usedBy = [...accountRows, ...projectRows].map((row) => text(row, "name"));
    if (usedBy.length) throw new FontInUseError(entry.family, usedBy);

    const row = this.db.prepare("SELECT media_id, ext FROM font WHERE id = ?").get(id) as
      Row | undefined;
    this.db.prepare("DELETE FROM font WHERE id = ?").run(id);
    const mediaId = row ? text(row, "media_id") : "";
    // Best-effort file cleanup. remove() is synchronous by contract, so the
    // unlink is fire-and-forget rather than awaited; the database row, which
    // every reader trusts, is already gone. The .catch is what makes it
    // actually best-effort: MediaStore.remove rethrows anything that is not
    // ENOENT, and an unhandled rejection here (an EACCES or EPERM unlinking
    // the file, say) would crash the whole process, turning a 200 into the
    // server going down a moment later.
    if (mediaId && !this.mediaStillReferenced(mediaId)) {
      void this.media
        .remove(mediaId, row ? text(row, "ext") : "woff2")
        .catch((error: unknown) => {
          console.error(error);
        });
    }
  }

  /**
   * MediaStore is one content-addressed pool shared by fonts and library
   * images (media.ts): the same bytes can end up referenced from more than
   * one row — two Google families resolving to the same woff2 slice is the
   * concrete case, but a re-added family whose new download happens to match
   * an old, still-referenced blob hits it too. Every unlink in this service
   * used to fire the moment its OWN row stopped pointing at a blob, with no
   * check for whether some other row still did — deleting one font could
   * unlink a file another font's (or, in principle, another library item's)
   * `/media/<id>.<ext>` URL still promised was there, 404ing it. Mirrors
   * library.ts's own COUNT(*) guard, extended to both tables a font's blob
   * can be named from. Callers run this only after their own row's old
   * reference is already gone (an UPDATE that already ran, or a DELETE just
   * above), so the count reflects the state unlinking would actually leave.
   */
  private mediaStillReferenced(mediaId: string): boolean {
    const fontRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM font WHERE media_id = ?")
      .get(mediaId) as Row;
    const libraryRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM library_item WHERE media_id = ?")
      .get(mediaId) as Row;
    return integer(fontRow, "total") + integer(libraryRow, "total") > 0;
  }
}

/**
 * node:sqlite throws a plain Error carrying `code: "ERR_SQLITE_ERROR"` and
 * `errcode` set to the underlying SQLite result code — 2067 is
 * SQLITE_CONSTRAINT_UNIQUE. The message is checked too, narrowly, so this
 * cannot mistake some other UNIQUE column's violation for `family`'s.
 */
function isUniqueFamilyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 2067 && error.message.includes("font.family");
}

function mediaIdFor(db: DatabaseSync, id: string): string {
  const row = db.prepare("SELECT media_id FROM font WHERE id = ?").get(id) as
    Row | undefined;
  return row ? text(row, "media_id") : "";
}

function toEntry(row: Row): FontEntry {
  const mediaId = text(row, "media_id");
  const ext = text(row, "ext");
  const source: FontSource = text(row, "source") === "google" ? "google" : "builtin";
  return {
    id: text(row, "id"),
    family: text(row, "family"),
    weight: integer(row, "weight"),
    weightMin: optionalInteger(row, "weight_min"),
    weightMax: optionalInteger(row, "weight_max"),
    source,
    url:
      source === "google"
        ? `/media/${mediaId}.${ext}`
        : `/fonts/${slug(text(row, "family"))}.${ext}`,
  };
}

/** Turns "Space Mono" into "space-mono", matching the /fonts/:file route below. */
function slug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
