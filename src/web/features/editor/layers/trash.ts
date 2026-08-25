import type { EditorStore } from "../store.js";
import { deleteSelectedLayers } from "./actions.js";

/*
 * Dragging an overlay onto the asset rail's bin. Ported from pointerOverTrash
 * (app.js:3722-3728) and the two lines of beginLayerDrag that use it
 * (app.js:4007, app.js:4013).
 *
 * The bin belongs to the asset rail, which is a different component's, so it is
 * found by the attribute app.js already used rather than through a prop. That
 * keeps the drag working whether the rail is on screen or not, and it is the
 * same contract data-layer-kind is: an attribute two components agree on.
 */

/** The attribute the asset rail marks its bin with (app.js:3723). */
export const TRASH_ATTRIBUTE = "data-asset-trash";

/** Set on the bin while a drag is over it, so the rail can light it up. */
export const TRASH_HOT_ATTRIBUTE = "data-asset-trash-hot";

function trashElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TRASH_ATTRIBUTE}]`);
}

/** app.js:3722-3728. Whether the pointer is inside the bin's rectangle. */
export function pointerOverTrash(event: { clientX: number; clientY: number }): boolean {
  const trash = trashElement();
  if (trash === null) return false;
  const rect = trash.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

/** app.js:4007. The bin lights up under the pointer, so the drop is discoverable. */
export function highlightTrash(event: { clientX: number; clientY: number }): void {
  const trash = trashElement();
  if (trash === null) return;
  if (pointerOverTrash(event)) trash.setAttribute(TRASH_HOT_ATTRIBUTE, "true");
  else trash.removeAttribute(TRASH_HOT_ATTRIBUTE);
}

/**
 * app.js:4013. Releasing over the bin deletes the whole selection, not only the
 * overlay that was grabbed, because the whole selection moved with it.
 */
export function deleteOnPointerOverTrash(
  store: EditorStore,
  event: { clientX: number; clientY: number },
): boolean {
  trashElement()?.removeAttribute(TRASH_HOT_ATTRIBUTE);
  if (!pointerOverTrash(event)) return false;
  return deleteSelectedLayers(store);
}
