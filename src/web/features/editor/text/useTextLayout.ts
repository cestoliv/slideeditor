import { useMemo, useSyncExternalStore } from "react";
import { computeTextLayout, fontSizeAt, textFontString } from "@shared/text/index.js";
import type { MeasureText, TextLayout } from "@shared/text/index.js";
import type { TextLayer } from "@shared/schema/index.js";

/*
 * Binding computeTextLayout to the stage.
 *
 * app.js measured through measureFont (app.js:2736), a module-level canvas whose
 * font string was written out by hand at each call site. The string lives in the
 * shared module now, so the stage and the export cannot bind different faces.
 */

/** One canvas for the whole app, as app.js:2734 kept one. */
let measureCanvas: HTMLCanvasElement | null = null;

function measurerFor(fontSize: number): MeasureText {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (context === null) return (line) => line.length * fontSize * 0.5;
  context.font = textFontString(fontSize);
  return (line) => context.measureText(line).width;
}

type FontState = "idle" | "loading" | "ready";

let fontState: FontState = "idle";
const fontListeners = new Set<() => void>();

/**
 * Waits for TikTok Sans before anything is measured.
 *
 * app.js:4229 awaits the same load before rendering a slide to canvas, because
 * measureText otherwise falls back to a metrically different face and wraps the
 * lines somewhere else. The stage never waited, so the first paint of a cold
 * page wrapped against the fallback and only settled on the next edit.
 */
function ensureFontLoaded(): void {
  if (fontState !== "idle") return;
  fontState = "loading";
  void document.fonts
    .load(textFontString(64))
    .catch(() => undefined)
    .then(() => {
      fontState = "ready";
      for (const listener of [...fontListeners]) listener();
    });
}

function subscribeToFont(listener: () => void): () => void {
  fontListeners.add(listener);
  ensureFontLoaded();
  return () => {
    fontListeners.delete(listener);
  };
}

function fontIsReady(): boolean {
  return fontState === "ready";
}

export function useTextFontReady(): boolean {
  return useSyncExternalStore(subscribeToFont, fontIsReady, fontIsReady);
}

export type StageSize = { width: number; height: number };

/**
 * Everything needed to draw one text layer at the stage's current scale.
 *
 * `fontReady` is a dependency rather than a guard: the first layout of a cold
 * page is measured against whatever face is available, and recomputed once the
 * real one has loaded.
 */
export function useTextLayout(layer: TextLayer, stage: StageSize): TextLayout {
  const fontReady = useTextFontReady();
  return useMemo(
    () => {
      const fontSize = fontSizeAt(layer, stage.width);
      return computeTextLayout({
        layer,
        boxWidth: layer.width * stage.width,
        boxHeight: layer.height * stage.height,
        fontSize,
        measure: measurerFor(fontSize),
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
      stage.width,
      stage.height,
      fontReady,
    ],
  );
}
