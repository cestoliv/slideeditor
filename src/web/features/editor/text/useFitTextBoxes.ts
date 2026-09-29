import { useEffect, useMemo } from "react";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import { useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { layoutAt, useTextFontState } from "./useTextLayout.js";

/**
 * Grows every text box that drops a line, on every slide, once its face has
 * loaded.
 *
 * compose.ts sizes an agent's boxes from an average glyph advance, because the
 * server has no font to measure. A wider face, a heavier weight or a run of
 * capitals wraps to more lines than that estimate, and the box drops them on
 * the stage and in the export. Only the browser can measure the real face, so
 * the box is corrected here.
 *
 * It runs when a document arrives rather than on every edit. The store mutates
 * the project in place, so its identity only changes on an open or a reload.
 * The width stays as composed, at the account's maxWidth, and only the height
 * grows, with no cap.
 */
export function useFitTextBoxes(store: EditorStore): void {
  const project = useEditor(store, (state) => state.project);
  const faces = useMemo(() => {
    const byKey = new Map<string, { family: string; italic: boolean }>();
    for (const text of project.slides.flatMap((slide) => slide.texts)) {
      byKey.set(`${String(text.italic)}:${text.fontFamily}`, {
        family: text.fontFamily,
        italic: text.italic,
      });
    }
    return [...byKey.values()];
  }, [project]);
  const { ready, revision } = useTextFontState(faces);

  useEffect(() => {
    if (!ready) return;
    const canvas = { width: OUTPUT_WIDTH, height: outputHeight(project.ratio) };
    const short = project.slides
      .flatMap((slide) => slide.texts)
      .flatMap((text) => {
        const layout = layoutAt(text, canvas);
        return layout.lines.length < layout.totalLineCount
          ? [{ text, height: layout.contentHeight / canvas.height }]
          : [];
      });
    if (short.length === 0) return;
    store.mutate(
      () => {
        for (const { text, height } of short) text.height = height;
      },
      { history: false },
    );
  }, [store, project, ready, revision]);
}
