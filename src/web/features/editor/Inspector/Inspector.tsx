import type { LibraryIndex } from "../../../app/useLibrary.js";
import { Button, IconButton } from "../../../design/index.js";
import { activeSlideOf, useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { parseLayerKey } from "../selection.js";
import { deleteSelectedLayers } from "../layers/actions.js";
import { OverlayInspector } from "./OverlayInspector.js";
import { SlideInspector } from "./SlideInspector.js";
import { TextInspector } from "./TextInspector.js";
import styles from "./Inspector.module.css";

/*
 * The panel that styles whatever is selected. Ported from renderInspector
 * (app.js:1933-2064), which chooses between five bodies in one expression:
 * photo settings, a multi-selection, a crop in progress, one overlay, one text,
 * and the empty state when none of those holds.
 *
 * The layer it edits is the *primary* of the selection, the one app.js tracked
 * in state.selectedTextId and state.selectedOverlayId (app.js:400-410). A
 * multi-selection deliberately shows no controls at all: app.js:1953 renders an
 * empty body under a count and a delete button, and nothing there ever applied
 * a style to more than one layer.
 */

export type InspectorProps = {
  store: EditorStore;
  /** Resolves an overlay's itemId to the asset it names (app.js:1944). */
  library: LibraryIndex;
  /** app.js:1946. Placing the photo replaces the panel with the photo settings. */
  photoAdjust?: boolean;
  /**
   * Commits the crop the panel's Done button ends. Folding a crop back into an
   * overlay needs the asset's pixel size, which Task 15 owns (app.js:2299-2306).
   */
  onFinishCrop?: (() => void) | undefined;
  /**
   * app.js:1944. Below 780px the panel is a sheet over the canvas rather than a
   * column beside it, and this is whether it is up. It does nothing at all on a
   * wider screen, where the panel is always there.
   */
  mobileOpen?: boolean;
};

export function Inspector({
  store,
  library,
  photoAdjust = false,
  onFinishCrop,
  mobileOpen = false,
}: InspectorProps) {
  const slide = useEditor(store, activeSlideOf);
  const selection = useEditor(store, (state) => state.selection);
  const primary = useEditor(store, (state) => state.primary);
  const croppingOverlayId = useEditor(store, (state) => state.croppingOverlayId);
  const ratio = useEditor(store, (state) => state.project.ratio);

  const parsed = primary === null ? null : parseLayerKey(primary);
  const text =
    parsed?.kind === "text"
      ? (slide?.texts.find((item) => item.id === parsed.id) ?? null)
      : null;
  const overlay =
    parsed?.kind === "overlay"
      ? (slide?.overlays.find((item) => item.id === parsed.id) ?? null)
      : null;

  const photoMode = photoAdjust && slide !== null;
  const multi = selection.length > 1;
  const overlayMode = !photoMode && !multi && overlay !== null;
  const cropping = overlayMode && croppingOverlayId === overlay.id;
  const textMode = !photoMode && !multi && !overlayMode && text !== null;

  const title = photoMode
    ? "Photo settings"
    : multi
      ? `${String(selection.length)} layers selected`
      : cropping
        ? "Crop"
        : overlayMode
          ? "Overlay"
          : text !== null
            ? "Text settings"
            : "Text";

  /*
   * app.js:1951. The header's trash removes the whole selection, whether that
   * is one layer or nine, so all three of its variants call one action. Only
   * the accessible name differs, which is the part a reader hears.
   */
  const deleteLabel = multi
    ? "Delete selected layers"
    : overlayMode
      ? "Delete overlay"
      : textMode
        ? "Delete text"
        : null;

  return (
    <aside
      className={[styles.inspector, mobileOpen ? styles.mobileOpen : ""]
        .filter(Boolean)
        .join(" ")}
      data-inspector
      aria-label="Layer settings"
    >
      <div className={styles.header}>
        <h2>{title}</h2>
        {deleteLabel === null ? null : (
          <IconButton
            icon="trash"
            variant="plain"
            label={deleteLabel}
            onClick={() => {
              deleteSelectedLayers(store);
            }}
          />
        )}
      </div>
      {photoMode ? (
        <div className={styles.body}>
          <SlideInspector store={store} slide={slide} ratio={ratio} />
        </div>
      ) : multi ? null : cropping ? (
        <div className={styles.body}>
          <Button
            className={styles.reset ?? ""}
            variant="solid"
            onClick={() => {
              onFinishCrop?.();
            }}
          >
            Done
          </Button>
        </div>
      ) : overlayMode ? (
        <div className={styles.body}>
          <OverlayInspector
            store={store}
            overlay={overlay}
            asset={library.get(overlay.itemId) ?? null}
          />
        </div>
      ) : textMode ? (
        <div className={styles.body}>
          <TextInspector store={store} text={text} ratio={ratio} />
        </div>
      ) : (
        <div className={styles.empty}>
          <span aria-hidden="true">T</span>
          <p>
            {slide === null
              ? "Add a photo to start placing text."
              : "Select text or an overlay, or add one to this photo."}
          </p>
        </div>
      )}
    </aside>
  );
}
