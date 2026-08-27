import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { textFontString } from "@shared/text/index.js";
import { injectFontFaces, resetFontFacesForTesting } from "../../../app/fontFaces.js";
import { resetTextFontStateForTesting, useTextFontState } from "./useTextLayout.js";

/*
 * The cold-boot race this file exists to catch.
 *
 * main.tsx no longer imports a static fonts.css, so at the stage's very first
 * commit there is genuinely no @font-face rule registered anywhere:
 * injectFontFaces()'s fetch has not resolved yet. Every other browser test in
 * this app imports fonts.css or testFonts.css directly, so a face always
 * exists before anything mounts — exactly the condition that hides this bug.
 * This file deliberately imports neither.
 *
 * document.fonts.load() for a family with no declared @font-face does not
 * error and does not wait: FontFaceSet resolves it almost immediately with an
 * empty result. Calling it before the catalogue has arrived, and then never
 * calling it again (ensureFontLoaded's once-per-family guard), meant the
 * stage would settle "ready" against a face that never existed and never
 * retry once the real one showed up.
 */

function Probe({ family }: { family: string }) {
  // Inlined rather than through a dedicated useTextFontReady wrapper — that
  // wrapper was exported only for this file to call and nothing in
  // production ever used it (useTextLayout, the one real caller, always
  // reads useTextFontState directly for both `ready` and `revision`).
  const { ready } = useTextFontState([family]);
  return <p>{ready ? "ready" : "waiting"}</p>;
}

// Finding 5 from the multi-account review: fontStates (this module's own
// cache) had no reset to go with fontFaces.ts's resetFontFacesForTesting, so
// a family one test settled "ready" (matched or not) answered a later,
// unrelated test's request for the same family instantly — skipping the
// cold-boot path most of the tests below exist to exercise.
beforeEach(() => {
  resetFontFacesForTesting();
  resetTextFontStateForTesting();
});

afterEach(() => {
  Reflect.deleteProperty(document.fonts, "load");
  vi.unstubAllGlobals();
});

it("does not ask the browser for a family until the catalogue that declares it has arrived", async () => {
  const realLoad = document.fonts.load.bind(document.fonts);
  const loadedFonts: string[] = [];
  document.fonts.load = async (font: string, text?: string) => {
    loadedFonts.push(font);
    return realLoad(font, text);
  };

  // The gate is what makes this an ordering test rather than a race: the
  // catalogue fetch cannot resolve until this test releases it, so nothing
  // below is waiting on a clock.
  let releaseCatalogue: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseCatalogue = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          fonts: [
            {
              id: "1",
              family: "Space Mono",
              weight: 400,
              source: "google",
              url: "/media/abc.woff2",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );

  const injecting = injectFontFaces();
  const screen = await render(<Probe family="Space Mono" />);

  await expect.element(screen.getByText("waiting")).toBeVisible();
  expect(
    loadedFonts,
    "the buggy version asked the browser for the family immediately, before the catalogue that declares it had arrived",
  ).toEqual([]);

  releaseCatalogue();
  await injecting;

  await expect.element(screen.getByText("ready")).toBeVisible();
  // Finding 10: the browser is asked at the family's real catalogued weight
  // (400, from the fixture's own @font-face row above) rather than the
  // TEXT_WEIGHT (500) default — a mismatch here is exactly what makes CSS
  // matching pick the wrong face and the browser synthesise bold.
  expect(loadedFonts).toEqual([textFontString(64, "Space Mono", 400)]);
});

/*
 * Finding 5 from the multi-account review: a family whose first attempt
 * settled "ready" against no matched face at all (a failed boot fetch, most
 * often — see the file-level comment above for why document.fonts.load()
 * does not error on that) never got asked about again, because
 * ensureFontLoaded's once-per-family guard treated "settled" and "actually
 * resolved" as the same thing. A later fetch that succeeded and genuinely
 * named the family in @font-face rules changed nothing this module still
 * checked.
 */
it("asks the browser for a family again once a later catalogue install actually names it", async () => {
  const loadedFonts: string[] = [];
  const realLoad = document.fonts.load.bind(document.fonts);
  document.fonts.load = async (font: string, text?: string) => {
    loadedFonts.push(font);
    return realLoad(font, text);
  };

  // No injectFontFaces() call at all yet: whenCatalogueReady() is already
  // resolved (the module's initial state) and no @font-face rule for this
  // family exists anywhere. The first attempt settles "ready" against
  // nothing, exactly the state a failed boot fetch would leave behind.
  const screen = await render(<Probe family="Space Mono" />);
  await expect.element(screen.getByText("ready")).toBeVisible();
  expect(loadedFonts).toEqual([textFontString(64, "Space Mono")]);

  // A later fetch succeeds and genuinely names the family.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fonts: [
              {
                id: "1",
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

  // The fix: this install is exactly the thing the family needed, so it is
  // asked about a second time rather than staying settled against the first,
  // empty answer for the rest of the session. Finding 10: the retry asks at
  // the family's now-catalogued real weight (400), not the TEXT_WEIGHT
  // default the first, catalogue-less attempt above had no choice but to use.
  await expect
    .poll(() => loadedFonts)
    .toEqual([textFontString(64, "Space Mono"), textFontString(64, "Space Mono", 400)]);
  // Still ready throughout: the retry corrects the metrics without ever
  // making the stage wait on it again.
  await expect.element(screen.getByText("ready")).toBeVisible();
});
