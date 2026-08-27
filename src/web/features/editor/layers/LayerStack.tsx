import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import type { AccountDefaults, LibraryItem } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { activeSlideOf, useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { slideItems } from "../selection.js";
import { addTextLayer, deleteSelectedLayers, nudgeSelection } from "./actions.js";
import { LayerMenu } from "./LayerMenu.js";
import { OverlayLayer } from "./OverlayLayer.js";
import { TextLayerView } from "./TextLayerView.js";
import type { GestureContext } from "./gestures.js";
import { useCrop } from "./useCrop.js";
import { useStageBox } from "./useStageBox.js";
import { useAssetDrop } from "./useAssetDrop.js";
import { isEditingTextTarget, useLayerClipboard } from "./useLayerClipboard.js";
import { useEditorShortcuts } from "./useEditorShortcuts.js";
import { layerClipboard } from "./clipboard.js";
import type { LayerClipboard } from "./clipboard.js";
import type { CaretRequest } from "../text/InlineTextEditor.js";
import styles from "./LayerStack.module.css";

/*
 * Every layer on the active slide, in one z-order, plus the editor-wide
 * behaviour the layers share: which text is being edited, the crop session, the
 * clipboard, the asset drop, and the keys that act on a selection.
 *
 * The listeners below are on the document because that is where app.js put
 * them (app.js:4818-4880) and because the elements they watch belong to other
 * components. Each one is gated on the stage's own rectangle rather than on a
 * class name, so nothing here reaches into another task's DOM.
 */

export type LayerStackOptions = {
  store: EditorStore;
  library: LibraryIndex;
  /** The active slideshow's own account defaults, applied to a text layer added here. */
  defaults: AccountDefaults;
  /** app.js:1700. While the photo is placed the layers step aside entirely. */
  photoAdjust?: boolean | undefined;
  /** Puts a dropped or pasted image into the library. */
  upload?: ((file: File, name: string) => Promise<LibraryItem>) | undefined;
  remember?: ((item: LibraryItem) => void) | undefined;
  toast?: ((message: string) => void) | undefined;
  /** Overridden by a test that needs its own in-memory slot. */
  clipboard?: LayerClipboard | undefined;
};

export type LayerStack = {
  /** The layer stack, for Stage's children. */
  layers: ReactNode;
  /**
   * Commits an open crop. Stage calls this instead of clearing the selection
   * when a click lands on the surface, because folding a crop back into an
   * overlay needs the asset's pixel size (app.js:2299-2306).
   */
  onFinishCrop: () => void;
};

type Editing = { id: string; caret: CaretRequest };

/** One press moves one pixel of the export; Shift moves ten. */
const NUDGE_COARSE = 10;

const NUDGE: Record<string, { x: number; y: number } | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export function useLayerStack({
  store,
  library,
  defaults,
  photoAdjust = false,
  upload,
  remember,
  toast,
  clipboard = layerClipboard,
}: LayerStackOptions): LayerStack {
  const { ref, size, rectOf } = useStageBox();
  const [editing, setEditing] = useState<Editing | null>(null);

  const slide = useEditor(store, activeSlideOf);
  const selection = useEditor(store, (state) => state.selection);
  const primary = useEditor(store, (state) => state.primary);
  const croppingOverlayId = useEditor(store, (state) => state.croppingOverlayId);
  const ratio = useEditor(store, (state) => state.project.ratio);

  const assetOf = useCallback(
    (itemId: string): LibraryItem | null => library.get(itemId) ?? null,
    [library],
  );

  const context: GestureContext = useMemo(
    () => ({ store, stage: size, rectOf }),
    [rectOf, size, store],
  );

  const crop = useCrop({ ...context, ratio, assetOf });
  const finishCrop = crop.finish;

  const startEditing = useCallback((id: string, caret: CaretRequest) => {
    setEditing({ id, caret });
  }, []);

  const endEditing = useCallback(() => {
    setEditing(null);
  }, []);

  /*
   * app.js:4826-4832, and it is a capturing listener there for the same reason:
   * the press has to be judged before the element under it acts on it.
   *
   * A press inside the inspector commits the text and keeps the layer selected,
   * so pressing a colour swatch does not empty the panel it belongs to.
   */
  useEffect(() => {
    if (editing === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const box = target.closest('[data-layer-kind="text"]');
      if (box !== null && box.getAttribute("data-layer-id") === editing.id) return;
      setEditing(null);
      if (target.closest("[data-inspector], .inspector") === null) {
        store.clearSelection();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [editing, ratio, store]);

  /* app.js:4838-4880. Escape leaves the edit, and Delete removes the selection. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && editing !== null) {
        event.preventDefault();
        setEditing(null);
        // app.js:4844. Focus goes back to the box before the editor unmounts,
        // and without a scroll, so a keyboard reader keeps their place in the
        // layer stack.
        document
          .querySelector<HTMLElement>(
            `[data-layer-kind="text"][data-layer-id="${CSS.escape(editing.id)}"]`,
          )
          ?.focus({ preventScroll: true });
        return;
      }
      /*
       * Two guards, and the first cannot be killed by a test. Editing is only
       * ever open with the focus inside the editor, because its blur handler
       * closes it, so isEditingTextTarget below already catches every reachable
       * case. It stays anyway: subtlety 2 exists because app.js decided this
       * from the DOM alone, and a rewrite that leans on where the focus happens
       * to be has moved back toward that. This is the explicit state, and it is
       * the one that would still be right if the blur handler ever changed.
       */
      if (editing !== null) return;
      if (isEditingTextTarget(event.target)) return;

      if (event.key === "Backspace" || event.key === "Delete") {
        if (store.getSnapshot().selection.length === 0) return;
        event.preventDefault();
        deleteSelectedLayers(store);
        return;
      }

      /*
       * Escape backs out of a selection, so a keyboard reader is not left with
       * one held open and no way to drop it. The focus stays on the layer, so
       * Tab carries on from where they were.
       */
      if (event.key === "Escape") {
        if (store.getSnapshot().selection.length === 0) return;
        event.preventDefault();
        store.clearSelection();
        return;
      }

      /*
       * The arrows move the selection. New: app.js bound none, so selecting a
       * layer from the keyboard would have left it reachable but still
       * unmovable. One press is one output pixel and Shift is ten, which is the
       * step every canvas editor uses, and both are expressed in the export's
       * own pixels so a nudge means the same thing at any zoom.
       */
      const step = NUDGE[event.key];
      if (step === undefined) return;
      if (store.getSnapshot().selection.length === 0) return;
      event.preventDefault();
      const scale = event.shiftKey ? NUDGE_COARSE : 1;
      nudgeSelection(
        store,
        (step.x * scale) / OUTPUT_WIDTH,
        (step.y * scale) / outputHeight(ratio),
      );
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [editing, ratio, store]);

  /* app.js:2296-2311. A double click on bare canvas adds a text and opens it. */
  useEffect(() => {
    if (photoAdjust) return;
    const onDoubleClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-layer-kind]") !== null) {
        return;
      }
      if (store.getSnapshot().croppingOverlayId !== null) return;
      const rect = rectOf();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (
        event.clientX < rect.left ||
        event.clientX > rect.left + rect.width ||
        event.clientY < rect.top ||
        event.clientY > rect.top + rect.height
      ) {
        return;
      }
      event.preventDefault();
      const id = addTextLayer(
        store,
        {
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        },
        defaults,
      );
      // app.js:2979-2984 opens the new box for editing straight away, which is
      // what makes a double click feel like one action rather than two.
      if (id !== null) setEditing({ id, caret: { mode: "all" } });
    };
    document.addEventListener("dblclick", onDoubleClick);
    return () => {
      document.removeEventListener("dblclick", onDoubleClick);
    };
  }, [defaults, photoAdjust, rectOf, store]);

  // Undo and redo, on the document as app.js:4861 had them. They live behind
  // this hook rather than in Editor.tsx so the shared file takes no more wiring.
  useEditorShortcuts(store);

  useLayerClipboard({
    store,
    ratio,
    assetOf,
    clipboard,
    editing: editing !== null,
    upload,
    remember,
    toast,
  });

  useAssetDrop({
    store,
    ratio,
    assetOf,
    rectOf,
    element: ref,
    upload,
    remember,
    toast,
    enabled: !photoAdjust,
  });

  const only = selection.length === 1;

  const layers = (
    <div
      ref={ref}
      className={styles.stack}
      data-testid="layer-stack"
      // The measured stage, published so a reader (and a test) can see the
      // number every pointer conversion below divides by.
      data-stage-width={size.width}
      data-stage-height={size.height}
    >
      {slideItems(slide).map((entry) => {
        const selected = selection.includes(entry.key);
        const isPrimary = primary === entry.key;
        if (entry.kind === "overlay") {
          const cropping = croppingOverlayId === entry.item.id;
          return (
            <LayerMenu
              key={entry.key}
              store={store}
              kind="overlay"
              id={entry.item.id}
              canCrop={only && selected}
              onCrop={crop.begin}
            >
              <OverlayLayer
                store={store}
                overlay={entry.item}
                asset={assetOf(entry.item.itemId)}
                ratio={ratio}
                selected={selected}
                primary={isPrimary}
                handles={selected && only}
                cropping={cropping}
                context={context}
                crop={crop}
                onFinishCrop={finishCrop}
              />
            </LayerMenu>
          );
        }
        return (
          <LayerMenu
            key={entry.key}
            store={store}
            kind="text"
            id={entry.item.id}
            canCrop={false}
            onCrop={crop.begin}
          >
            <TextLayerView
              store={store}
              layer={entry.item}
              selected={selected}
              primary={isPrimary}
              handles={selected && only}
              editing={editing?.id === entry.item.id}
              caret={editing?.caret ?? { mode: "all" }}
              context={context}
              onStartEditing={startEditing}
              onEndEditing={endEditing}
              onFinishCrop={finishCrop}
            />
          </LayerMenu>
        );
      })}
    </div>
  );

  return { layers, onFinishCrop: finishCrop };
}
