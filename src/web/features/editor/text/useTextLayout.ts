import { useCallback, useMemo, useSyncExternalStore } from "react";
import { computeTextLayout, fontSizeAt, textFontString } from "@shared/text/index.js";
import type { MeasureText, TextLayout } from "@shared/text/index.js";
import type { TextLayer } from "@shared/schema/index.js";
import {
  onCatalogueInstalled,
  weightFor,
  whenCatalogueReady,
} from "../../../app/fontFaces.js";

/*
 * Binding computeTextLayout to the stage.
 *
 * app.js measured through measureFont (app.js:2736), a module-level canvas whose
 * font string was written out by hand at each call site. The string lives in the
 * shared module now, so the stage and the export cannot bind different faces.
 */

/** One canvas for the whole app, as app.js:2734 kept one. */
let measureCanvas: HTMLCanvasElement | null = null;

function measurerFor(fontSize: number, family: string): MeasureText {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (context === null) return (line) => line.length * fontSize * 0.5;
  context.font = textFontString(fontSize, family, weightFor(family));
  return (line) => context.measureText(line).width;
}

type FontState = "idle" | "loading" | "ready";

const fontStates = new Map<string, FontState>();
const fontListeners = new Set<() => void>();

/**
 * Bumped every time a family's `document.fonts.load()` attempt settles,
 * matched or not. `useTextLayout`'s memo depends on this (by way of
 * `familiesRevision` below) rather than on the plain ready boolean alone: a
 * family that settles "ready" against a fallback and later gets corrected —
 * see `unmatchedFamilies` — goes "ready" both times, so the boolean by
 * itself would never tell the memo anything changed.
 */
const fontRevisions = new Map<string, number>();

/**
 * Settled "ready" (so the stage never waits forever) against
 * `document.fonts.load()` resolving with no matched face — FontFaceSet does
 * this immediately, without erroring, for a family no @font-face rule names
 * yet. Held here so a catalogue that later installs the real rule (see
 * `onCatalogueInstalled` below) knows which families to redo; a family that
 * matched first try is never added and never revisited.
 */
const unmatchedFamilies = new Set<string>();

/**
 * Wired once, lazily, on the first family this module is ever asked to
 * load — not at module scope, so a test importing this module never starts
 * a subscription it has no way to tear down. Every family still marked
 * unmatched at the moment of a fresh install is worth redoing: the install
 * that just landed may be exactly the one that named it.
 */
let subscribedToCatalogue = false;

function retryUnmatchedFamilies(): void {
  const retrying = [...unmatchedFamilies];
  unmatchedFamilies.clear();
  for (const family of retrying) {
    fontStates.delete(family);
    ensureFontLoaded(family);
  }
}

/**
 * Waits for one family before anything using it is measured. Keyed per
 * family, because a slide can now mix TikTok Sans with an account's other
 * fonts, and each needs its own load rather than one flag for all of them.
 *
 * app.js:4229 awaits the same load before rendering a slide to canvas, because
 * measureText otherwise falls back to a metrically different face and wraps the
 * lines somewhere else. The stage never waited, so the first paint of a cold
 * page wrapped against the fallback and only settled on the next edit.
 *
 * A family that fails to load still settles to "ready" rather than leaving
 * the stage waiting forever: it lays out against whatever fallback face the
 * browser used instead, which is the same outcome a family that loaded
 * successfully but metrically differs from its declared face would already
 * produce. Unlike that metrical mismatch, though, a family that resolved
 * against nothing at all — see below — gets a second chance the moment a
 * fresher catalogue installs, rather than staying wrong for the rest of the
 * session.
 *
 * The load itself waits for whenCatalogueReady() first. On a cold boot,
 * useSession's call to ensureFontFacesLoaded() (fired the moment the session
 * probe comes back authenticated) is still awaiting its fetch when this
 * runs, so at that instant no @font-face rule exists for any family yet.
 * document.fonts.load() for an undeclared family doesn't error and doesn't
 * wait — it resolves almost immediately with an empty result — so calling it
 * before the catalogue arrives would settle this family "ready" against a
 * face that doesn't exist. That empty result is exactly what
 * `unmatchedFamilies` catches: `whenCatalogueReady()` only promises that
 * *some* attempt — this boot's own, if it eventually succeeds, or a failed
 * one settling for good — has finished, not that THIS family's rule was
 * part of it (a boot fetch that failed outright leaves every family
 * unmatched; a slower fetch racing this call the same way).
 */
function ensureFontLoaded(family: string): void {
  if (!subscribedToCatalogue) {
    subscribedToCatalogue = true;
    onCatalogueInstalled(retryUnmatchedFamilies);
  }
  if (fontStates.has(family)) return;
  fontStates.set(family, "loading");
  void whenCatalogueReady()
    .then(() => document.fonts.load(textFontString(64, family, weightFor(family))))
    .then(
      (matches) => matches.length > 0,
      () => false,
    )
    .then((matched) => {
      if (matched) unmatchedFamilies.delete(family);
      else unmatchedFamilies.add(family);
      fontStates.set(family, "ready");
      fontRevisions.set(family, (fontRevisions.get(family) ?? 0) + 1);
      for (const listener of [...fontListeners]) listener();
    });
}

function familiesReady(families: readonly string[]): boolean {
  return families.every((family) => fontStates.get(family) === "ready");
}

/** Summed rather than kept as a tuple/array: only whether it CHANGED matters
 * to a memo depending on it, and a fresh array every render would defeat
 * memoisation the same way a plain object identity would. */
function familiesRevision(families: readonly string[]): number {
  let total = 0;
  for (const family of families) total += fontRevisions.get(family) ?? 0;
  return total;
}

/**
 * The single subscription behind both a caller that only wants the ready
 * boolean (this module's own browser test's Probe component) and
 * useTextLayout's own revision dependency, below. The two used to be
 * separate useSyncExternalStore hooks with identical subscribe bodies (one
 * wrapped in a since-removed useTextFontReady) — every text layer's
 * useTextLayout call, which needs both a ready boolean and a revision
 * number, registered two listeners on `fontListeners` and ran the
 * `ensureFontLoaded` loop twice per settle for the same families. One
 * subscription, keyed on the revision number, is enough: `revision` and
 * `ready` are always updated together, in the same synchronous block inside
 * ensureFontLoaded's settle handler, before `fontListeners` is ever
 * notified, so reading `familiesReady` straight from `fontStates` at the
 * instant the revision snapshot is taken is exactly as current as giving
 * `ready` its own subscription would have been — without a second one.
 *
 * `families` is a dependency, not a guard: the first layout of a cold page is
 * measured against whatever face is available, and recomputed once every
 * requested family has loaded (see useTextLayout below).
 *
 * Exported for that browser test alone — useTextLayout (the only production
 * caller) reaches this directly, below.
 */
export function useTextFontState(families: string[]): {
  ready: boolean;
  revision: number;
} {
  // Without useCallback this closure is a fresh function every render, and
  // useSyncExternalStore unsubscribes and resubscribes whenever the function
  // it was given changes identity. Harmless (ensureFontLoaded is idempotent
  // per family) but pure churn, since `families` is the only thing this
  // closure actually depends on.
  const subscribe = useCallback(
    (listener: () => void) => {
      for (const family of families) ensureFontLoaded(family);
      fontListeners.add(listener);
      return () => {
        fontListeners.delete(listener);
      };
    },
    [families],
  );
  const revision = useSyncExternalStore(
    subscribe,
    () => familiesRevision(families),
    () => familiesRevision(families),
  );
  return { ready: familiesReady(families), revision };
}

/**
 * Clears every module-level font-state singleton above. Exists for tests
 * only, the same way fontFaces.ts's resetFontFacesForTesting does — without
 * it, one browser test's family (settled "ready", matched or not) answers a
 * later, unrelated test's request for the same family instantly, skipping
 * the very cold-boot path that test exists to exercise.
 */
export function resetTextFontStateForTesting(): void {
  fontStates.clear();
  fontListeners.clear();
  fontRevisions.clear();
  unmatchedFamilies.clear();
}

export type StageSize = { width: number; height: number };

/**
 * Everything needed to draw one text layer at the stage's current scale.
 *
 * `fontReady` is a dependency rather than a guard: the first layout of a cold
 * page is measured against whatever face is available, and recomputed once the
 * real one has loaded. `fontRevision` is a second, independent dependency for
 * the same reason: a family that settled "ready" against no matched face and
 * is later corrected (retryUnmatchedFamilies, above) goes "ready" both times,
 * so `fontReady` alone would never tell this memo the metrics underneath had
 * changed.
 */
export function useTextLayout(layer: TextLayer, stage: StageSize): TextLayout {
  // A new array literal changes identity every render, which would resubscribe
  // useTextFontState's effect on every render rather than only when the family
  // actually changes. Memoising on layer.fontFamily keeps the identity stable.
  const families = useMemo(() => [layer.fontFamily], [layer.fontFamily]);
  const { ready: fontReady, revision: fontRevision } = useTextFontState(families);
  return useMemo(
    () => {
      const fontSize = fontSizeAt(layer, stage.width);
      return computeTextLayout({
        layer,
        boxWidth: layer.width * stage.width,
        boxHeight: layer.height * stage.height,
        fontSize,
        measure: measurerFor(fontSize, layer.fontFamily),
      });
    },
    // The layer object is mutated in place by the store, so its identity is not
    // a dependency anything can rely on. Every field the layout reads is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      layer,
      layer.text,
      layer.width,
      layer.height,
      layer.size,
      layer.style,
      layer.backgroundShape,
      layer.align,
      layer.fontFamily,
      stage.width,
      stage.height,
      fontReady,
      fontRevision,
    ],
  );
}
