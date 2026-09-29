import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { outlineColorFor, textColorOf } from "@shared/geometry/index.js";
import type { TextLayout } from "@shared/text/index.js";
import type { TextLayer } from "@shared/schema/index.js";
import { editorText, placeTextCaret, selectAllOf } from "./inlineEditing.js";
import { textBlockStyle } from "./renderTextDom.js";
import styles from "./InlineTextEditor.module.css";

/*
 * The editor that takes over from the painted glyphs while a layer is edited.
 * Ported from startTextEditing (app.js:3899-3948) and styles.css:1828-1853.
 *
 * It paints its own glyphs, and text.module.css hides the painted block
 * underneath. The browser then draws the caret and the selection on the same
 * text it edits. A transparent editor over the painted render put the caret
 * wherever the two layouts disagreed, which was anywhere whitespace collapsed
 * or a line wrapped differently. The pills, the rules and the box still come
 * from the shared layout, and the block is the layout's wrap column, so the
 * browser breaks lines where the export does.
 *
 * It mounts when editing starts and unmounts when editing ends, so the caret
 * work below runs once per editing session rather than on every keystroke.
 */

export type CaretRequest =
  /** Entering by double click or by Enter replaces the whole line (app.js:3943). */
  | { mode: "all" }
  /** Entering by a click lands the caret where the click did (app.js:3947). */
  | { mode: "point"; clientX: number; clientY: number };

export type InlineTextEditorProps = {
  /** The layer's text at the moment editing started. */
  value: string;
  layout: TextLayout;
  layer: TextLayer;
  caret: CaretRequest;
  /** Runs on every keystroke with the editor's text, already stripped. */
  onInput: (value: string) => void;
  onBlur: () => void;
  onKeyDown?: ((event: KeyboardEvent<HTMLSpanElement>) => void) | undefined;
};

export function InlineTextEditor({
  value,
  layout,
  layer,
  caret,
  onInput,
  onBlur,
  onKeyDown,
}: InlineTextEditorProps) {
  const editor = useRef<HTMLSpanElement | null>(null);
  // Read through a ref so the mount effect below can stay empty-dependency: it
  // has to run once, when the element appears, and never again.
  const opening = useRef({ value, caret });

  useEffect(() => {
    const element = editor.current;
    if (element === null) return;
    // React never owns this element's children. Writing the text here rather
    // than rendering it keeps React from replacing the text node under the
    // caret on the next render, which would drop the selection mid-word.
    element.textContent = opening.current.value;
    // app.js:3944. A zoomed or scrolled workspace would otherwise jump to bring
    // the layer into view every time an edit begins.
    element.focus({ preventScroll: true });
    const request = opening.current.caret;
    if (request.mode === "all") selectAllOf(element);
    else placeTextCaret(element, request.clientX, request.clientY);
  }, []);

  const color = textColorOf(layer);
  const style: CSSProperties = {
    ...textBlockStyle(layout, layer),
    color,
    // The painted outline is an SVG stroke behind the fill. This is the same
    // stroke in CSS, so an outline layer keeps its look while it is edited.
    ...(layer.style === "outline"
      ? {
          WebkitTextStroke: `${String(layout.outlineWidth)}px ${outlineColorFor(color)}`,
          paintOrder: "stroke fill",
        }
      : {}),
  };

  return (
    <span
      ref={editor}
      className={styles.editor}
      data-text-editor="true"
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label="Edit text layer"
      aria-multiline="true"
      onInput={() => {
        const element = editor.current;
        if (element === null) return;
        onInput(editorText(element));
      }}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}
