import { useEffect, useMemo } from "react";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import { useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { layoutAt, useTextFontState } from "./useTextLayout.js";

/**
 * Grows every text box that drops a line, on every slide, once its face has
 * loaded.
 *
 * compose.ts measures each face from its own file and counts the pills, so a
 * box it composes holds all of it already. This catches the rest: a document
 * composed before it did, a face file the server could not read, an emoji
 * below 30px, and a box a human made too short by hand.
 *
 * The correction is not saved by itself, so opening a document writes no
 * version. The stage and the export both draw from the corrected document in
 * memory. The human's next save carries the new height to the server, and
 * layoutChanged then counts that slide as changed.
 *
 * It runs when a document arrives rather than on every edit. The store mutates
 * the project in place, so its identity only changes on an open or a reload.
 * The width and the position stay as they are, and only the height grows,
 * with no cap.
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
        // A box short only of its pills keeps its height: the stage clips a
        // text at the canvas, not at its box, so its pills show whole anyway,
        // and growing every such box would count it in layoutChanged.
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
      { history: false, save: false },
    );
  }, [store, project, ready, revision]);
}
