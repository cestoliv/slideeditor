import { afterEach, expect, it } from "vitest";
import { vi } from "vitest";
import { TEXT_WEIGHT } from "@shared/text/index.js";
// Only for the design-system-coverage test below, which reads these tokens'
// real values rather than hardcoding them a second time here.
import "../design/tokens.css";
// Only for the design-system-coverage test below, which now reads TikTok
// Sans's declared weight axis from the static face design/fonts.css ships —
// finding 3 makes injectFontFaces() skip re-declaring this exact family, so
// it is no longer observable through the injected <style> this file's other
// tests inspect.
import "../design/fonts.css";
import {
  ensureFontFacesLoaded,
  injectFontFaces,
  resetFontFacesForTesting,
  weightFor,
  whenCatalogueReady,
} from "./fontFaces.js";

afterEach(() => {
  document.querySelectorAll("style[data-fonts]").forEach((style) => {
    style.remove();
  });
  vi.unstubAllGlobals();
});

it("injects one @font-face rule per catalogued font, except the builtin design/fonts.css already ships statically", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
                family: "TikTok Sans",
                weight: 500,
                source: "builtin",
                url: "/fonts/tiktok-sans.ttf",
              },
              {
                id: "2",
                family: "Space Mono",
                weight: 400,
                source: "google",
                url: "/media/abc.woff2",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  await injectFontFaces();

  const style = document.querySelector("style[data-fonts]");
  expect(style).not.toBeNull();
  expect(style?.textContent).toContain('font-family: "Space Mono"');
  expect(style?.textContent).toContain("/media/abc.woff2");
  // Finding 3: TikTok Sans is already declared in design/fonts.css, pointed
  // at Vite's fingerprinted, immutably-cached bundle asset. Re-declaring it
  // here too, pointed at the un-cached /fonts/* route, used to make the
  // browser download the same 1.2MB face twice and reflow the page once
  // this <style> (appended last, so it wins the cascade) landed.
  expect(style?.textContent).not.toContain('font-family: "TikTok Sans"');
  expect(style?.textContent).not.toContain("/fonts/tiktok-sans.ttf");
});

/*
 * faceRule() interpolates a font's family and url straight into a
 * double-quoted CSS string. Both come from the catalogue, and a family name
 * in particular is whatever POST /api/fonts's caller sent — a name
 * containing a `"` would otherwise close the `font-family` declaration
 * early and let the rest of it be interpreted as CSS injected into the
 * page's own <style> element, not just displayed as text.
 */
it("escapes a quote in a family name rather than letting it break out of the declaration", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
                family:
                  'Evil"; } body { display: none; } @font-face { font-family: "Evil',
                weight: 400,
                source: "google",
                url: "/media/abc.woff2",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  await injectFontFaces();

  const rule = document.querySelector("style[data-fonts]")?.textContent ?? "";
  // Both embedded quotes are escaped rather than left to close the
  // font-family string early.
  expect(rule).toContain(
    'font-family: "Evil\\"; } body { display: none; } @font-face { font-family: \\"Evil"',
  );
  // The unescaped form is not present too — if it were, the browser would
  // parse the payload as its own, separate declarations instead of the one,
  // inert family name it actually is.
  expect(rule).not.toContain(
    'font-family: "Evil"; } body { display: none; } @font-face { font-family: "Evil"',
  );
});

/*
 * escapeCssString handled `\` and `"` but not a raw newline (or CR/FF). A
 * literal newline inside a CSS string is a parse error: the string becomes a
 * "bad-string-token" and recovery consumes everything up to the next `}` —
 * which the family name itself supplies right after the newline — leaving
 * whatever follows in the source parsed as top-level rules in a real
 * <style> element, not the one inert family name it was meant to be. Not
 * reachable through Google Fonts today (Google has to recognise the family
 * first), but POST /api/fonts keeps an interior newline verbatim, so the
 * escape is the only thing standing between one and a broken stylesheet.
 */
it("escapes a newline, carriage return and form feed in a family name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
                family:
                  'Evil\n"; } body { display: none; } @font-face { font-family: "\r\fEvil',
                weight: 400,
                source: "google",
                url: "/media/abc.woff2",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  await injectFontFaces();

  const rule = document.querySelector("style[data-fonts]")?.textContent ?? "";
  expect(rule).not.toContain("\n");
  expect(rule).not.toContain("\r");
  expect(rule).not.toContain("\f");
  expect(rule).toContain(
    'font-family: "Evil\\A \\"; } body { display: none; } @font-face { font-family: \\"\\D \\C Evil"',
  );
});

/*
 * TikTokSans.ttf is itself a variable font — its own fvar table carries a
 * 300-900 weight axis (min 300, default 300, max 900), which is what both
 * the static design/fonts.css and the catalogue's own BUILTIN_FONTS row
 * (server/services/fonts.ts) declare today. Pinning the @font-face to the
 * single seeded weight (500) instead, the way the single-value form always
 * did,
 * exposes only that one instance: a design-system rule asking for
 * --font-weight-semibold (650) or heavier then matches nothing on the face
 * and the browser synthesises bold rather than using the font's own
 * instances.
 *
 * Uses a synthetic family rather than the real "TikTok Sans" fixture: finding
 * 3 makes injectFontFaces() skip that exact family (it's already declared
 * statically in design/fonts.css), so a rule keyed to it would never reach
 * the DOM this test inspects. faceRule()'s range-declaration logic itself is
 * generic — driven by weightMin/weightMax on the entry, not by family name —
 * so a stand-in family still exercises the same code path.
 */
it("declares a variable font's full weight range rather than pinning it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
                family: "Test Variable Sans",
                weight: 500,
                weightMin: 300,
                weightMax: 900,
                source: "builtin",
                url: "/fonts/test-variable-sans.ttf",
              },
              {
                id: "2",
                family: "Space Mono",
                weight: 400,
                weightMin: null,
                weightMax: null,
                source: "builtin",
                url: "/fonts/space-mono.ttf",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  await injectFontFaces();

  const rule = document.querySelector("style[data-fonts]")?.textContent ?? "";
  expect(rule).toContain('font-family: "Test Variable Sans"');
  expect(rule).toContain("font-weight: 300 900");
  // The static face keeps the single-value form: it has no other instance to
  // expose, and a range on it would just make the browser search for
  // instances that do not exist.
  expect(rule).toContain('font-family: "Space Mono"');
  expect(rule).toContain("font-weight: 400;");
  expect(rule).not.toContain("font-weight: 400 400");
});

/*
 * The concrete failure mode finding 2 is about, checked directly against the
 * design system rather than against faceRule()'s output: every
 * --font-weight-* token tokens.css declares must fall inside the range
 * design/fonts.css's own @font-face declares for TikTok Sans (300-900), so
 * the browser can resolve each one to a real instance of the variable font
 * instead of synthesising bold for whichever token exceeds the range a
 * pinned single-value @font-face would have exposed.
 *
 * Reads the static declaration directly (via document.styleSheets) rather
 * than injectFontFaces()'s output: finding 3 makes that skip TikTok Sans
 * entirely, since design/fonts.css is what actually declares it now, for
 * every screen including the ones before sign-in.
 */
it("covers every design-system font-weight token within TikTok Sans's declared axis", () => {
  const tokens = getComputedStyle(document.documentElement);
  const weights = [
    "--font-weight-regular",
    "--font-weight-medium",
    "--font-weight-semibold",
    "--font-weight-bold",
    "--font-weight-heavy",
  ].map((name) => Number(tokens.getPropertyValue(name)));
  expect(weights.every((weight) => Number.isFinite(weight) && weight > 0)).toBe(true);

  const fontFaceRule = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    })
    .find(
      (rule): rule is CSSFontFaceRule =>
        rule instanceof CSSFontFaceRule &&
        rule.style.getPropertyValue("font-family").replace(/["']/g, "") === "TikTok Sans",
    );
  expect(
    fontFaceRule,
    "design/fonts.css's TikTok Sans @font-face was not found",
  ).toBeDefined();

  const [min, max] =
    /^(\d+)\s+(\d+)$/
      .exec(fontFaceRule?.style.getPropertyValue("font-weight") ?? "")
      ?.slice(1)
      .map(Number) ?? [];
  expect(min).toBe(300);
  expect(max).toBe(900);
  for (const weight of weights) {
    expect(weight).toBeGreaterThanOrEqual(min ?? Infinity);
    expect(weight).toBeLessThanOrEqual(max ?? -Infinity);
  }
});

/*
 * AccountsAdmin calls injectFontFaces() again after every font it adds, so
 * this has to run more than once per page load. A style element appended
 * fresh each time would leave every earlier catalogue's rules in the
 * document, painting whichever one the browser resolves first rather than
 * the current catalogue.
 */
it("replaces the previous catalogue's rules rather than piling up alongside them", async () => {
  const fontsResponse = (fonts: unknown[]) =>
    new Response(JSON.stringify({ fonts }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fontsResponse([
        {
          id: "1",
          family: "TikTok Sans",
          weight: 500,
          source: "builtin",
          url: "/fonts/tiktok-sans.ttf",
        },
      ]),
    ),
  );
  await injectFontFaces();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fontsResponse([
        {
          id: "2",
          family: "Space Mono",
          weight: 400,
          source: "google",
          url: "/media/abc.woff2",
        },
      ]),
    ),
  );
  await injectFontFaces();

  const styles = document.querySelectorAll("style[data-fonts]");
  expect(styles).toHaveLength(1);
  expect(styles[0]?.textContent).not.toContain("TikTok Sans");
  expect(styles[0]?.textContent).toContain("Space Mono");
});

it("does nothing when the catalogue cannot be reached", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
  await injectFontFaces();
  expect(document.querySelector("style[data-fonts]")).toBeNull();
});

/*
 * The font catalogue carries each family's real weight (a Google family can be
 * 400 while TEXT_WEIGHT is 500), and this is the only place in src/web that can
 * reach it. Everything that paints or measures text resolves through this
 * function rather than assuming TEXT_WEIGHT, so a face registered off-weight
 * cannot make the browser synthesise bold on one render path and not the
 * other.
 */
it("resolves a family's real weight from the loaded catalogue", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
                family: "TikTok Sans",
                weight: 500,
                source: "builtin",
                url: "/fonts/tiktok-sans.ttf",
              },
              {
                id: "2",
                family: "Space Mono",
                weight: 400,
                source: "google",
                url: "/media/abc.woff2",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );

  await injectFontFaces();

  expect(weightFor("Space Mono")).toBe(400);
  expect(weightFor("TikTok Sans")).toBe(500);
});

it("falls back to TEXT_WEIGHT for a family the catalogue does not know", () => {
  expect(weightFor("Some Family Nobody Catalogued")).toBe(TEXT_WEIGHT);
});

function deferredResponse(): { promise: Promise<Response>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<Response>((res) => {
    resolve = () =>
      res(
        new Response(JSON.stringify({ fonts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
  });
  return { promise, resolve };
}

/*
 * Finding 3: a second injectFontFaces() call starting before the first
 * settles overwrites the single module-level resolveCatalogueReady, so the
 * first call's own `finally` ends up resolving the SECOND call's promise
 * instead of its own — and whoever asked whenCatalogueReady() while only the
 * first call was in flight is left holding a promise nothing ever resolves.
 * Real triggers: api.ts dispatching `unauthorized` re-injects via session.ts
 * on any 401, AccountsAdmin injects after every font add, and StrictMode
 * double-mounts in dev — any of which can start a second call while an
 * earlier one (or the initial boot fetch) is still in flight.
 */
it("resolves every waiter even when a second injectFontFaces starts before the first settles", async () => {
  const first = deferredResponse();
  const second = deferredResponse();
  const responses = [first.promise, second.promise];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responses.shift()),
  );

  const callA = injectFontFaces();
  // Captured while only A is in flight — this is the promise the bug leaves
  // unresolved forever.
  const waiterDuringA = whenCatalogueReady();
  const callB = injectFontFaces();

  let settled = false;
  void waiterDuringA.then(() => {
    settled = true;
  });

  first.resolve();
  await callA;
  // A alone finishing must not be mistaken for the whole catalogue settling:
  // B is still in flight, so the waiter must still be waiting.
  await Promise.resolve();
  expect(settled, "must not resolve early off A's completion alone").toBe(false);

  second.resolve();
  await callB;
  // B, the newer call, is the one whose completion is actually required —
  // this ordering (A settles first, B last) cannot tell that apart from the
  // old "every overlapping call" rule, since both agree here. The test below
  // is the one that tells them apart.
  await Promise.race([
    waiterDuringA,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("whenCatalogueReady() never resolved")), 200),
    ),
  ]);
  expect(settled).toBe(true);
});

/*
 * Finding 3: catalogueReady used to resolve only once EVERY overlapping
 * injectFontFaces() call reached its `finally` (an `inFlight === 0` gate),
 * not just the freshest one. A's fetch below never settles at all — no
 * AbortSignal.timeout on the plain `fetch("/api/fonts")` this module used to
 * call directly — so under that rule `inFlight` never returns to zero, and a
 * waiter asking whenCatalogueReady() after B (the newer, successful call)
 * started hangs for the life of the page even though B installed a working
 * catalogue. Consumers see no error: the stage never reports fonts ready,
 * and clicking Export never starts.
 */
it("resolves a waiter once the newer call finishes, even though an older call never settles", async () => {
  const stalled = new Promise<Response>(() => {
    // Deliberately never resolved or rejected — the reproduction is
    // specifically that nothing ever settles this one.
  });
  const second = deferredResponse();
  const responses: Promise<Response>[] = [stalled, second.promise];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responses.shift()),
  );

  const callA = injectFontFaces();
  const waiterAfterAStarted = whenCatalogueReady();
  const callB = injectFontFaces();

  let settled = false;
  void waiterAfterAStarted.then(() => {
    settled = true;
  });

  second.resolve();
  await callB;
  // B's own completion is what the waiter is owed — A being permanently
  // stalled must not be able to withhold it.
  await Promise.race([
    waiterAfterAStarted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("whenCatalogueReady() never resolved")), 200),
    ),
  ]);
  expect(settled).toBe(true);

  // callA is intentionally left unresolved when the test ends; nothing here
  // awaits it.
  void callA;
});

function deferredFonts(family: string): {
  promise: Promise<Response>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<Response>((res) => {
    resolve = () =>
      res(
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: family,
                family,
                weight: 500,
                source: "builtin",
                url: `/fonts/${family}.ttf`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
  });
  return { promise, resolve };
}

/*
 * Finding 6: injectFontFaces() has no request sequencing of its own — a
 * second call starting before an earlier one's response has arrived must
 * not let that earlier, now-stale response overwrite what the later call
 * found once it (the earlier one) finally does resolve. Mirrors
 * AccountsStore's own `latest` counter (accounts.tsx).
 */
it("does not let a slower earlier response overwrite a newer one's catalogue", async () => {
  const older = deferredFonts("Older Family");
  const newer = deferredFonts("Newer Family");
  const responses = [older.promise, newer.promise];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responses.shift()),
  );

  const callA = injectFontFaces();
  const callB = injectFontFaces();

  // The newer call's own response arrives and is applied first.
  newer.resolve();
  await callB;
  expect(document.querySelector("style[data-fonts]")?.textContent).toContain(
    "Newer Family",
  );

  // The older call's response finally arrives, after B already won — it
  // must not clobber the catalogue B already installed.
  older.resolve();
  await callA;
  const rule = document.querySelector("style[data-fonts]")?.textContent ?? "";
  expect(rule).toContain("Newer Family");
  expect(rule).not.toContain("Older Family");
});

/*
 * Fix round 4, finding 5: readiness used to be gated by `request ===
 * latestRequest` — the highest request number ever STARTED — for both
 * installing a response and resolving `catalogueReady`. That let a NEWER
 * call's failure resolve readiness (with nothing installed) while an OLDER
 * call was still in flight and about to succeed, and then let that older
 * call's later success be discarded outright, because by the time it
 * arrived a newer (failed) request number had already taken over
 * "freshest". A caller awaiting whenCatalogueReady() saw `catalogue` stay
 * empty forever, even though a real response was on its way.
 */
it("installs a still-pending older call's success after a newer call has already failed", async () => {
  const older = deferredFonts("Rescued Family");
  let resolveFailure!: () => void;
  const failure = new Promise<Response>((resolve) => {
    resolveFailure = () => resolve(new Response("", { status: 500 }));
  });
  const responses: Promise<Response>[] = [older.promise, failure];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responses.shift()),
  );

  const callA = injectFontFaces();
  const waiterAfterAStarted = whenCatalogueReady();
  const callB = injectFontFaces();

  let settled = false;
  void waiterAfterAStarted.then(() => {
    settled = true;
  });

  // The newer call (B) fails first. Its failure must not resolve readiness
  // while the older call (A), which is still in flight and will succeed,
  // has not had its own turn yet.
  resolveFailure();
  await callB;
  await Promise.resolve();
  expect(settled, "must not resolve on the newer call's failure alone").toBe(false);
  expect(document.querySelector("style[data-fonts]")).toBeNull();

  // A's success is the last word: nothing newer is still in flight to
  // supersede it, so it installs the catalogue and resolves readiness.
  older.resolve();
  await callA;
  await Promise.race([
    waiterAfterAStarted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("whenCatalogueReady() never resolved")), 200),
    ),
  ]);
  expect(settled).toBe(true);
  expect(document.querySelector("style[data-fonts]")?.textContent).toContain(
    "Rescued Family",
  );
});

/*
 * Fix round 4, finding 6: /api/fonts's 401 makes call() (api.ts) dispatch
 * `unauthorized`; useSession listens and re-probes `/api/auth/session`, and
 * on `authenticated: true` calls ensureFontFacesLoaded() again — the same
 * shape a real loop takes whenever the two endpoints' auth guards disagree.
 * Each turn of the loop below stands in for one such re-probe. Nothing
 * bounded this before: every turn fired a fresh fetch, forever.
 */
it("stops retrying automatically after repeated failures, rather than looping forever", async () => {
  resetFontFacesForTesting();
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return new Response("", { status: 401 });
    }),
  );

  async function settleOneTurn(): Promise<void> {
    ensureFontFacesLoaded();
    // ensureFontFacesLoaded() is fire-and-forget. Whether or not this turn
    // actually started a fetch, whenCatalogueReady() reflects the most
    // recent attempt (or is already resolved if this turn's guard refused
    // to start one), so awaiting it lets each simulated turn's outcome
    // settle before the next one decides whether to fire.
    await Promise.race([
      whenCatalogueReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("whenCatalogueReady() never resolved")), 200),
      ),
    ]);
  }

  for (let turn = 0; turn < 6; turn += 1) {
    await settleOneTurn();
  }

  // Bounded well short of the 6 turns actually run.
  expect(calls).toBeLessThan(6);
  const callsAfterGivingUp = calls;

  // And it stays bounded: further turns fire no further fetches.
  await settleOneTurn();
  await settleOneTurn();
  expect(calls).toBe(callsAfterGivingUp);
});
