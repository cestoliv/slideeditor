import { DEFAULT_FONT_FAMILY, TEXT_WEIGHT } from "@shared/text/index.js";
import type { FontEntry } from "@shared/schema/index.js";
import { api } from "./api.js";

function formatFor(url: string): string {
  if (url.endsWith(".woff2")) return "woff2";
  if (url.endsWith(".woff")) return "woff";
  if (url.endsWith(".otf")) return "opentype";
  return "truetype";
}

/**
 * `weightMin`/`weightMax` are set only for a builtin whose bundled binary is
 * itself a variable font (currently just TikTok Sans). Declaring the whole
 * axis rather than the single seeded weight is what the static
 * design/fonts.css also declares (`font-weight: 300 900`, matching this
 * catalogue's own seeded row for the same family) for main.tsx's pre-auth
 * import — every screen before sign-in has no fetched catalogue to draw an
 * @font-face rule from at all — while this fetched one is what every screen
 * after sign-in measures and paints against instead: without a range, a
 * design-system rule asking for a heavier instance (--font-weight-semibold
 * and up) matches nothing on this single-weight face and the browser
 * synthesises bold instead of using the font's own instances. A static face
 * — every Google family, and a builtin with only one instance in its file —
 * keeps the single-value form, pinned at its one real weight.
 */
function fontWeightDeclaration(font: FontEntry): string {
  // A single null check, not a pair of typeof guards: fontEntrySchema
  // enforces "set together or not at all" itself (see shared/schema/font.ts),
  // so every FontEntry that reaches here — api.listFonts() runs each entry
  // through fontEntrySchema before catalogue is ever assigned — already has
  // both bounds as numbers or both as null, never a mix.
  if (font.weightMin !== null && font.weightMax !== null) {
    return `${String(font.weightMin)} ${String(font.weightMax)}`;
  }
  return String(font.weight);
}

/**
 * A family name is whatever the catalogue holds, and POST /api/fonts takes
 * one straight from the caller — nothing about it is guaranteed to be safe
 * to drop into a double-quoted CSS string. A name containing a `"` would
 * otherwise close the `font-family` declaration early and let the rest of
 * it, and everything appended after it in the same rule, be interpreted as
 * arbitrary CSS injected into the page (this stylesheet is a real
 * `<style>` element, not text a browser merely displays).
 *
 * A raw newline (or CR/FF) is escaped too, as a CSS hex escape (`\A `, not a
 * literal control character) — an unescaped one inside a CSS string is a
 * parse error: the string token becomes a "bad-string-token" and recovery
 * consumes everything up to the next `}`, which the family name (or url)
 * itself supplies right after it, leaving whatever followed in the source
 * parsed as top-level rules instead of a quoted string's contents. Nothing
 * strips a newline out of `family` on the way in — POST /api/fonts keeps one
 * verbatim (`String(field(body,"family") ?? "").trim()` only trims the ends)
 * — so this escape is the only thing standing between an interior newline
 * and a real `<style>` element.
 */
function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\A ")
    .replace(/\r/g, "\\D ")
    .replace(/\f/g, "\\C ");
}

function faceRule(font: FontEntry): string {
  const family = escapeCssString(font.family);
  const url = escapeCssString(font.url);
  return `@font-face { font-family: "${family}"; src: url("${url}") format("${formatFor(
    font.url,
  )}"); font-weight: ${fontWeightDeclaration(font)}; font-display: swap; }`;
}

/**
 * The catalogue this page has seen, kept for weightFor. Empty until
 * injectFontFaces resolves, and left as-is if the fetch fails, so a failed
 * refetch cannot erase a catalogue an earlier successful one already loaded.
 */
let catalogue: readonly FontEntry[] = [];

/**
 * The resolver for whenCatalogueReady() while a fetch this module started is
 * still authoritative — set the instant that fetch begins, cleared the
 * instant it is answered for. There is only ever one: a second
 * injectFontFaces() call starting before the first settles does not get its
 * own — it shares this one, since only one promise (`catalogueReady`) is
 * ever handed out at a time. Never overwritten out from under an earlier
 * caller the way that used to go wrong: a naive reassignment on every call
 * start would let a second call's resolver replace the first's, so the first
 * call's own `finally` ended up resolving nothing while the first call's own
 * waiters were left holding a promise nothing would ever settle.
 */
let pendingResolver: (() => void) | null = null;

/**
 * The request numbers of every injectFontFaces() call currently between its
 * first await and its `finally`. A Set rather than a bare count so a call's
 * `finally` can ask "does anything still running outrank me" precisely,
 * rather than just "is the count above zero" — see `installedRequest` and
 * the `finally` block below for why that distinction is the fix for finding
 * 5. `.delete()` on a request already absent (the shape a stale call's own
 * `finally` takes after resetFontFacesForTesting() has cleared this) is a
 * silent no-op, so unlike a bare counter this can never be driven negative.
 */
const inFlightRequests = new Set<number>();

/**
 * Numbers every call, so freshness can be compared by when a call STARTED.
 * Mirrors AccountsStore's own `latest` (src/web/app/accounts.tsx). Bumped by
 * every call and never reset — including by resetFontFacesForTesting(),
 * which runs between tests while a previous test's call can still be
 * between its `await api.listFonts()` and its `finally`. Resetting this to 0
 * would let that stale call's `request` collide with the next test's first
 * call — both would read 1 — so the stale call's late answer would look
 * exactly as fresh as the new test's own, install the previous test's
 * catalogue over it, and resolve the new test's readiness before its own
 * fetch had installed anything.
 */
let latestRequest = 0;

/**
 * The request number of whichever call most recently installed `catalogue`.
 * Never reset, for the same reason `latestRequest` above is not: it has to
 * stay ahead of every request number a leaked call from an earlier test
 * could still be carrying.
 *
 * Gates two things, both against "is a fresher answer already in, or still
 * possibly coming":
 *
 * - Installing a response (in the try block): a call whose request is
 *   behind `installedRequest` already lost to something fresher and does
 *   not overwrite it. This used to compare against `latestRequest` — the
 *   highest request ever STARTED — instead of the highest ever INSTALLED,
 *   which meant a call that started before a later call that went on to
 *   FAIL still got treated as superseded, and its own good response was
 *   silently discarded once it arrived. `installedRequest` only advances on
 *   an actual install, so a later call's failure cannot retroactively lock
 *   out an earlier call's still-pending success.
 *
 * - Resolving `catalogueReady` (in the `finally`): waiters are told "ready"
 *   once no in-flight call could still outrank what is currently installed
 *   — i.e. no member of `inFlightRequests` exceeds `installedRequest`. A
 *   call whose fetch never settles (no bound on it) does not block this: it
 *   only matters while its own request is still ahead of whatever has
 *   already been installed, exactly the condition that makes it possibly
 *   still relevant. Once something newer than it has installed, it is
 *   permanently irrelevant and is ignored whether or not it ever finishes.
 */
let installedRequest = 0;

/**
 * How many attempts in a row have failed since the last one that actually
 * installed a catalogue. Incremented by any failed attempt, direct or
 * auto-fired, and reset by any successful install. Only ever CHECKED by
 * ensureFontFacesLoaded()'s own guard below, which is what bounds a loop
 * this module can otherwise drive on its own: /api/fonts's 401 makes
 * `call()` (api.ts) dispatch `unauthorized`; useSession listens and calls
 * refresh(), which re-probes `/api/auth/session` and, on
 * `authenticated: true`, calls ensureFontFacesLoaded() again; that fetch
 * 401s again the same way, in a cycle nothing else here caps. It only takes
 * the two endpoints' authentication guards to disagree even briefly — a
 * path-scoped proxy rule, a session-store bug — for this to spin
 * indefinitely, two requests per turn, with no backoff. Refusing to start a
 * further auto-fired attempt once this reaches the limit starves the loop of
 * the only thing keeping it going: a fresh 401 to dispatch. A direct
 * injectFontFaces() call (AccountsAdmin, after adding a font) is a real,
 * user-initiated action rather than part of this cycle, and reads none of
 * this — it always attempts, even while the count sits at the limit.
 */
let consecutiveFailures = 0;

/** ensureFontFacesLoaded() gives up retrying automatically after this many failures in a row. */
const FONT_CATALOGUE_AUTO_FAILURE_LIMIT = 3;

/**
 * Told apart from `whenCatalogueReady()` on purpose: that promise settles
 * once per attempt, and a caller that already consumed it (useTextLayout.ts's
 * ensureFontLoaded, on a cold boot whose first fetch failed) has no way to
 * hear about a LATER attempt installing real rules. This fires every time an
 * attempt actually installs a fresh `<style>` — not on a failed one, which
 * changes nothing a listener needs to redo — so such a caller can retry
 * whatever it settled early against a face that did not exist yet.
 */
const catalogueListeners = new Set<() => void>();

/** Notified once per successful install — see `catalogueListeners` above. */
export function onCatalogueInstalled(listener: () => void): () => void {
  catalogueListeners.add(listener);
  return () => {
    catalogueListeners.delete(listener);
  };
}

/**
 * Set once a fetch has actually populated the catalogue. Lets
 * ensureFontFacesLoaded() below skip a redundant refetch — and the whole
 * <style> tag rewrite that comes with it — for a repeat authenticated probe
 * that is not a real sign-in (any 401 anywhere re-runs useSession's refresh,
 * and StrictMode double-mounts it too). Left false on a failed or invalid
 * fetch, so the next probe still retries rather than giving up for the rest
 * of the session.
 */
let loaded = false;

/**
 * Settles once the current injectFontFaces() attempt has finished, success or
 * failure. Already resolved before injectFontFaces is ever called (or if it
 * is never called at all, which every browser test but this module's own
 * covers a face for statically instead), so a caller that awaits this before
 * asking the browser for a family never blocks on a fetch nobody is making.
 */
let catalogueReady: Promise<void> = Promise.resolve();

/**
 * Resolves once the current (or, if none is in flight, the most recent)
 * catalogue fetch has settled.
 *
 * The whole reason this exists: on a cold boot, useSession's refresh()
 * (session.ts) calls injectFontFaces() synchronously from the resolved
 * session probe's promise handler, and is still awaiting its fetch when
 * React's other first effects run, so at that instant zero @font-face rules
 * are registered anywhere. A family requested
 * from document.fonts.load() at that moment doesn't error and doesn't wait —
 * FontFaceSet resolves it almost immediately with an empty result, against a
 * face that doesn't exist yet. A caller that awaits this promise first (see
 * useTextLayout.ts's ensureFontLoaded) asks only once the real @font-face
 * rules — or the certainty that the fetch failed and none are coming — are
 * actually in place.
 */
export function whenCatalogueReady(): Promise<void> {
  return catalogueReady;
}

/**
 * A family's real weight, as downloaded, or TEXT_WEIGHT for a family the
 * catalogue does not know about.
 *
 * A Google family can be weight 400 while TEXT_WEIGHT is 500. Painting a 400
 * face at a requested weight of 500 makes the browser synthesise bold on some
 * render paths (DOM) and not others (canvas), which is the silent
 * editor/export mismatch this function exists to prevent: every caller that
 * builds a font string or a paint prop resolves the weight through here
 * instead of assuming TEXT_WEIGHT.
 */
export function weightFor(family: string): number {
  return catalogue.find((font) => font.family === family)?.weight ?? TEXT_WEIGHT;
}

/**
 * Injects one @font-face rule per catalogued font — every Google family an
 * account has added, plus the builtin's own weight range — once
 * authenticated. main.tsx's static design/fonts.css import still declares
 * the builtin alone, for the screens before that: fetching this catalogue at
 * boot rather than bundling every family is what lets an added family show
 * up without a rebuild, but it also means nothing here is available before
 * /api/fonts's own auth guard lets it through.
 *
 * Fire-and-forget: nothing here blocks first paint, the same way
 * font-display: swap already lets the stage measure against a fallback face
 * and settle once the real one arrives (useTextFontState, useTextLayout.ts).
 *
 * `knownFonts`, when passed, skips the /api/fonts fetch entirely and installs
 * this list directly — everything else (catalogue/weightFor update, the
 * <style> rewrite, request sequencing, listener notification) runs exactly
 * as it does for a fresh fetch. AccountsAdmin's addFont() is the one caller
 * that has this: adding a font already calls AccountsStore.addGoogleFont(),
 * whose own refresh() just re-fetched /api/fonts a moment earlier for the
 * admin form's own font list, so re-fetching it a second time here purely to
 * rebuild the <style> tag was a second identical round trip for data already
 * in hand.
 */
export async function injectFontFaces(knownFonts?: readonly FontEntry[]): Promise<void> {
  if (pendingResolver === null) {
    // Nothing is currently authoritative: start a fresh pending signal,
    // synchronously and before the first await below, so that anything
    // reading whenCatalogueReady() after this call returns (session.ts's
    // refresh() fires `void injectFontFaces()` from inside the resolved
    // session probe's .then(), which runs to its first await before React's
    // other first effects ever get a chance to) sees the pending promise
    // rather than the already-resolved one it replaces. A call that starts
    // while another is already authoritative deliberately does NOT do this:
    // it joins the same pending promise instead, so a waiter caught mid an
    // earlier call keeps the same promise object rather than being handed
    // one whose resolver only the earlier call still holds.
    catalogueReady = new Promise((resolve) => {
      pendingResolver = resolve;
    });
  }
  const request = (latestRequest += 1);
  inFlightRequests.add(request);
  try {
    let response: { fonts: readonly FontEntry[] };
    if (knownFonts) {
      response = { fonts: knownFonts };
    } else {
      try {
        // api.listFonts() carries its own bounded timeout (api.ts), so this
        // await cannot hang forever even when the server never answers.
        response = await api.listFonts();
      } catch {
        // Covers a network error, a non-2xx response, a timed-out request and
        // a response whose top-level `{ fonts: [...] }` shape does not parse
        // at all — call() and parseFontEntries have already shaped and logged
        // whatever there is to say about it (parseFontEntries drops a
        // malformed row rather than throwing, so one never reaches here — see
        // shared/schema/font.ts; AccountsStore.refresh(), not this boot-time
        // fetch, is what surfaces a dropped row to someone who can act on it).
        // Nothing here is updated, and the
        // previous catalogue (if any) stands. This return still runs the
        // `finally` below, whose own check is what lets a still-pending,
        // OLDER call's later success go on to matter rather than being
        // silently locked out by this failure — see `installedRequest`'s doc
        // comment.
        consecutiveFailures += 1;
        return;
      }
    }
    // A call whose response already lost to something fresher does not
    // overwrite it — see `installedRequest`'s own doc comment for why this
    // compares against the highest request actually INSTALLED rather than
    // the highest one merely started.
    if (request < installedRequest) return;
    const fonts = response.fonts;
    catalogue = fonts;
    loaded = true;
    installedRequest = request;
    consecutiveFailures = 0;
    // Reused across calls rather than appended fresh each time: AccountsAdmin
    // re-invokes injectFontFaces() on every font add, and the attribute here
    // is the handle that finds the previous element instead of leaving it
    // behind to keep painting stale @font-face rules alongside the new ones.
    let style = document.querySelector<HTMLStyleElement>('style[data-fonts="catalogue"]');
    if (style === null) {
      style = document.createElement("style");
      style.setAttribute("data-fonts", "catalogue");
      document.head.appendChild(style);
    }
    // TikTok Sans is also declared statically in design/fonts.css, pointed at
    // Vite's fingerprinted, immutably-cached bundle asset so it is available
    // before sign-in. Re-declaring it here too, pointed at /fonts/*
    // (max-age=3600) instead, used to make the browser download the same
    // 1.2MB face twice and swap it in once this <style> — appended after,
    // so it wins the cascade — landed, reflowing the page right after
    // sign-in. Skipping it here leaves the static declaration as the only
    // one in effect; keeping the two descriptor-identical (family, weight
    // range) is still on whoever edits either one — see design/fonts.css's
    // own comment and BUILTIN_FONTS in server/services/fonts.ts.
    style.textContent = fonts
      .filter((font) => font.family !== DEFAULT_FONT_FAMILY)
      .map(faceRule)
      .join("\n");
    for (const listener of [...catalogueListeners]) listener();
  } finally {
    inFlightRequests.delete(request);
    // Waiters may be told "ready" once nothing still running could still
    // outrank what is currently installed — see `installedRequest`'s own
    // doc comment. A call that has already been outranked (by a fresher
    // install, or by never being able to catch up to one) does nothing here:
    // either `pendingResolver` was already cleared by whichever call
    // resolved it, or something still in flight outranks the currently
    // installed state and is left to decide when it finishes.
    const stillRacing = [...inFlightRequests].some(
      (pending) => pending > installedRequest,
    );
    if (!stillRacing && pendingResolver !== null) {
      const resolve = pendingResolver;
      pendingResolver = null;
      resolve();
    }
  }
}

/**
 * Loads the catalogue if it is not already loaded or already loading;
 * otherwise does nothing. For useSession's refresh() (session.ts), which
 * calls this on every authenticated session probe — not only the first: any
 * 401 anywhere re-runs refresh() to check whether the cookie is still good,
 * and StrictMode double-invokes it once more in dev. Without this guard,
 * each of those cost a full catalogue round trip and a wholesale <style>
 * rewrite for no reason, on top of the ones an actual sign-in already needed.
 *
 * AccountsAdmin.tsx calls injectFontFaces() directly instead, deliberately
 * bypassing this guard: adding a font is exactly the case where the
 * catalogue really is stale and a fresh fetch is the point.
 *
 * Also refuses once `consecutiveFailures` has reached
 * FONT_CATALOGUE_AUTO_FAILURE_LIMIT — see that variable's own doc comment
 * for the 401-triggered refresh loop this bounds.
 */
export function ensureFontFacesLoaded(): void {
  if (loaded || inFlightRequests.size > 0) return;
  if (consecutiveFailures >= FONT_CATALOGUE_AUTO_FAILURE_LIMIT) return;
  // injectFontFaces() itself swallows an unreachable server and an invalid
  // response on purpose (see above) — this catch is only for whatever it
  // does not anticipate, so a genuine bug here surfaces on the console
  // instead of vanishing as a silent, unlogged rejection.
  void injectFontFaces().catch((error: unknown) => {
    console.error("Failed to load the font catalogue.", error);
  });
}

/**
 * Resets every module-level singleton above to its initial state. Exists for
 * tests only: `loaded`, `catalogue`, `inFlightRequests`, `pendingResolver`
 * and `consecutiveFailures` persist for the life of the module (the whole
 * point of
 * ensureFontFacesLoaded's guard, in real use), which makes one test's call to
 * injectFontFaces() or ensureFontFacesLoaded() outlive it and change what a
 * later, unrelated test observes — `loaded` staying true is what let
 * session.browser.test.tsx's font-catalogue test depend on running before
 * anything else in its file touched these. Also removes the injected <style>
 * tag, so a later test's own query for it does not find a stale one.
 *
 * `latestRequest` and `installedRequest` are deliberately NOT reset — both
 * must stay monotonic across the life of the module, including across this
 * reset, so a call from a PREVIOUS test that is still between its
 * `await api.listFonts()` and its `finally` when this runs cannot come back
 * afterwards and find its own stale `request` numerically fresh again. See
 * their own doc comments for what resetting either would let a leaked call
 * do to a later test's catalogue and readiness.
 */
export function resetFontFacesForTesting(): void {
  catalogue = [];
  pendingResolver = null;
  inFlightRequests.clear();
  loaded = false;
  consecutiveFailures = 0;
  catalogueReady = Promise.resolve();
  document.querySelectorAll('style[data-fonts="catalogue"]').forEach((style) => {
    style.remove();
  });
}
