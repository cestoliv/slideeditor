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

function measurerFor(
  fontSize: number,
  family: string,
  weight: number,
  italic: boolean,
): MeasureText {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (context === null) return (line) => line.length * fontSize * 0.5;
  context.font = textFontString(fontSize, family, weight, italic);
  return (line) => context.measureText(line).width;
}

type FontState = "idle" | "loading" | "ready";

/** One family at one style: the roman and italic faces of a family load and
 * settle independently, so a caller asking about one must never be answered
 * from the other's state. */
type Face = { family: string; italic: boolean };

/**
 * A face is a family AND a style: the italic is a separate @font-face rule,
 * pointing at a separate file, that resolves on its own schedule. Keying this
 * module's state by family alone let an italic layer report "ready" the
 * moment the roman face landed, and measure its wrap against the roman
 * metrics.
 */
function faceKey(family: string, italic: boolean): string {
  return `${italic ? "italic" : "normal"}:${family}`;
}

const fontStates = new Map<string, FontState>();
const fontListeners = new Set<() => void>();

/**
 * Bumped every time a face's `document.fonts.load()` attempt settles,
 * matched or not. `useTextLayout`'s memo depends on this (by way of
 * `familiesRevision` below) rather than on the plain ready boolean alone: a
 * face that settles "ready" against a fallback and later gets corrected —
 * see `unmatchedFaces` — goes "ready" both times, so the boolean by
 * itself would never tell the memo anything changed.
 */
const fontRevisions = new Map<string, number>();

/**
 * Settled "ready" (so the stage never waits forever) against
 * `document.fonts.load()` resolving with no matched face — FontFaceSet does
 * this immediately, without erroring, for a face no @font-face rule names
 * yet. Held here (keyed by face, with the family/italic pair needed to redo
 * the load) so a catalogue that later installs the real rule (see
 * `onCatalogueInstalled` below) knows which faces to redo; a face that
 * matched first try is never added and never revisited.
 */
const unmatchedFaces = new Map<string, Face>();

/**
 * Wired once, lazily, on the first face this module is ever asked to
 * load — not at module scope, so a test importing this module never starts
 * a subscription it has no way to tear down. Every face still marked
 * unmatched at the moment of a fresh install is worth redoing: the install
 * that just landed may be exactly the one that named it.
 */
let subscribedToCatalogue = false;

function retryUnmatchedFaces(): void {
  const retrying = [...unmatchedFaces.values()];
  unmatchedFaces.clear();
  for (const { family, italic } of retrying) {
    fontStates.delete(faceKey(family, italic));
    ensureFontLoaded(family, italic);
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
 * `unmatchedFaces` catches: `whenCatalogueReady()` only promises that
 * *some* attempt — this boot's own, if it eventually succeeds, or a failed
 * one settling for good — has finished, not that THIS family's rule was
 * part of it (a boot fetch that failed outright leaves every family
 * unmatched; a slower fetch racing this call the same way).
 */
function ensureFontLoaded(family: string, italic: boolean): void {
  if (!subscribedToCatalogue) {
    subscribedToCatalogue = true;
    onCatalogueInstalled(retryUnmatchedFaces);
  }
  const key = faceKey(family, italic);
  if (fontStates.has(key)) return;
  fontStates.set(key, "loading");
  void whenCatalogueReady()
    // The family's own catalogued weight, while the measurer below asks for
    // the layer's. The catalogue self-hosts one file per family per style, so
    // CSS matching returns that single face whatever weight is requested:
    // this call fetches the file, and the requested weight only selects an
    // instance inside it. Keying the cache on the layer's weight would churn
    // it on every catalogue install for no extra file.
    .then(() =>
      document.fonts.load(textFontString(64, family, weightFor(family), italic)),
    )
    .then(
      (matches) => matches.length > 0,
      () => false,
    )
    .then((matched) => {
      if (matched) unmatchedFaces.delete(key);
      else unmatchedFaces.set(key, { family, italic });
      fontStates.set(key, "ready");
      fontRevisions.set(key, (fontRevisions.get(key) ?? 0) + 1);
      for (const listener of [...fontListeners]) listener();
    });
}

function familiesReady(faces: readonly Face[]): boolean {
  return faces.every(
    (face) => fontStates.get(faceKey(face.family, face.italic)) === "ready",
  );
}

/** Summed rather than kept as a tuple/array: only whether it CHANGED matters
 * to a memo depending on it, and a fresh array every render would defeat
 * memoisation the same way a plain object identity would. */
function familiesRevision(faces: readonly Face[]): number {
  let total = 0;
  for (const face of faces)
    total += fontRevisions.get(faceKey(face.family, face.italic)) ?? 0;
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
 * `faces` is a dependency, not a guard: the first layout of a cold page is
 * measured against whatever face is available, and recomputed once every
 * requested face has loaded (see useTextLayout below).
 *
 * Exported for that browser test alone — useTextLayout (the only production
 * caller) reaches this directly, below.
 */
export function useTextFontState(faces: Face[]): {
  ready: boolean;
  revision: number;
} {
  // Without useCallback this closure is a fresh function every render, and
  // useSyncExternalStore unsubscribes and resubscribes whenever the function
  // it was given changes identity. Harmless (ensureFontLoaded is idempotent
  // per face) but pure churn, since `faces` is the only thing this
  // closure actually depends on.
  const subscribe = useCallback(
    (listener: () => void) => {
      for (const face of faces) ensureFontLoaded(face.family, face.italic);
      fontListeners.add(listener);
      return () => {
        fontListeners.delete(listener);
      };
    },
    [faces],
  );
  const revision = useSyncExternalStore(
    subscribe,
    () => familiesRevision(faces),
    () => familiesRevision(faces),
  );
  return { ready: familiesReady(faces), revision };
}

/**
 * Clears every module-level font-state singleton above. Exists for tests
 * only, the same way fontFaces.ts's resetFontFacesForTesting does — without
 * it, one browser test's face (settled "ready", matched or not) answers a
 * later, unrelated test's request for the same face instantly, skipping
 * the very cold-boot path that test exists to exercise.
 */
export function resetTextFontStateForTesting(): void {
  fontStates.clear();
  fontListeners.clear();
  fontRevisions.clear();
  unmatchedFaces.clear();
}

export type StageSize = { width: number; height: number };

/**
 * Everything needed to draw one text layer at the stage's current scale.
 *
 * `fontReady` is a dependency rather than a guard: the first layout of a cold
 * page is measured against whatever face is available, and recomputed once the
 * real one has loaded. `fontRevision` is a second, independent dependency for
 * the same reason: a face that settled "ready" against no matched face and
 * is later corrected (retryUnmatchedFaces, above) goes "ready" both times,
 * so `fontReady` alone would never tell this memo the metrics underneath had
 * changed.
 */
export function useTextLayout(layer: TextLayer, stage: StageSize): TextLayout {
  // A new array literal changes identity every render, which would resubscribe
  // useTextFontState's effect on every render rather than only when the face
  // actually changes. Memoising on layer.fontFamily/layer.italic keeps the
  // identity stable.
  const faces = useMemo(
    () => [{ family: layer.fontFamily, italic: layer.italic }],
    [layer.fontFamily, layer.italic],
  );
  const { ready: fontReady, revision: fontRevision } = useTextFontState(faces);
  return useMemo(
    () => {
      const fontSize = fontSizeAt(layer, stage.width);
      return computeTextLayout({
        layer,
        boxWidth: layer.width * stage.width,
        boxHeight: layer.height * stage.height,
        fontSize,
        measure: measurerFor(
          fontSize,
          layer.fontFamily,
          weightFor(layer.fontFamily, layer.weight),
          layer.italic,
        ),
      });
    },
    // The layer object is mutated in place by the store, so its identity is not
    // a dependency anything can rely on. Every field the layout reads is listed.
    // layer.underline and layer.strikethrough are deliberately absent: they
    // change how the layout is painted, never how it wraps or measures.
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
      layer.weight,
      layer.italic,
      stage.width,
      stage.height,
      fontReady,
      fontRevision,
    ],
  );
}
