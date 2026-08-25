/*
 * The caret side of inline text editing, ported from placeTextCaret
 * (app.js:3875-3897) and the selection handling inside startTextEditing
 * (app.js:3941-3948).
 */

/**
 * Puts the caret where the click landed.
 *
 * Two APIs are tried because neither is universal: caretPositionFromPoint is
 * the standard and caretRangeFromPoint is WebKit's older name. Either can
 * answer with a node outside the editor when the click grazes a sibling, so the
 * result is checked before it is used, and collapsing to the end is the
 * fallback that always works.
 */
export function placeTextCaret(
  editor: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const selection = window.getSelection();
  if (selection === null) return;
  let range: Range | null = null;

  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(clientX, clientY);
    if (position !== null && editor.contains(position.offsetNode)) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  } else if (typeof document.caretRangeFromPoint === "function") {
    const candidate = document.caretRangeFromPoint(clientX, clientY);
    if (candidate !== null && editor.contains(candidate.startContainer)) {
      range = candidate;
    }
  }

  if (range === null) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** app.js:3943-3947. Entering by double click or by Enter replaces the whole line. */
export function selectAllOf(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * What the editor holds, as the layer would store it.
 *
 * app.js:3933 strips one trailing newline because contenteditable's innerText
 * always reports one. Without the strip every edit permanently grows a blank
 * line at the end of the layer.
 */
export function editorText(editor: HTMLElement): string {
  return editor.innerText.replace(/\n$/, "");
}
