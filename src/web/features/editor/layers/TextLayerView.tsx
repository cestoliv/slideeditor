import { useCallback, useEffect, useRef } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { TextLayer } from "@shared/schema/index.js";
import type { EditorStore } from "../store.js";
import {
  TEXT_RESIZE_LIMITS,
  deleteSelectedLayers,
  prepareLayerPointerSelection,
  slideOf,
} from "./actions.js";
import { useMoveGesture, useResizeGesture, useRotateGesture } from "./gestures.js";
import type { GestureContext, LayerRect } from "./gestures.js";
import { LayerBox, layerClipCss } from "./LayerBox.js";
import type { Handle } from "./LayerBox.js";
import { InlineTextEditor } from "../text/InlineTextEditor.js";
import type { CaretRequest } from "../text/InlineTextEditor.js";
import { renderTextDom, textBlockStyle } from "../text/renderTextDom.js";
import { useTextLayout } from "../text/useTextLayout.js";
import styles from "./TextLayerView.module.css";

/*
 * One text layer on the canvas. Ported from renderTextBox (app.js:1865-1900),
 * updateTextBox (app.js:2701-2732), bindTextBox (app.js:3815-3865),
 * endTextEditing (app.js:3950-3967) and ensureTextFits (app.js:2931-2947).
 *
 * Which layer is being edited is a prop rather than a class on the DOM node.
 * app.js kept it in `.is-editing` alone (subtlety 2), and the five paths that
 * leave editing all had to agree on that one class; here entry and exit run
 * through the same pair of callbacks.
 */

export type TextLayerViewProps = {
  store: EditorStore;
  layer: TextLayer;
  selected: boolean;
  primary: boolean;
  /** app.js:1986. Handles show for a single selection only. */
  handles: boolean;
  /** True while this layer holds the inline editor. */
  editing: boolean;
  /** Where the caret goes when the editor opens. Only read while editing. */
  caret: CaretRequest;
  context: GestureContext;
  onStartEditing: (id: string, caret: CaretRequest) => void;
  onEndEditing: () => void;
  /** app.js:3835. A press on a layer while cropping commits the crop instead. */
  onFinishCrop: () => void;
};

export function TextLayerView({
  store,
  layer,
  selected,
  primary,
  handles,
  editing,
  caret,
  context,
  onStartEditing,
  onEndEditing,
  onFinishCrop,
}: TextLayerViewProps) {
  const textId = layer.id;
  const { stage } = context;
  const layout = useTextLayout(layer, stage);
  const box = useRef<HTMLDivElement | null>(null);

  const writeText = useCallback(
    (change: (live: TextLayer) => void, history = false) => {
      const activeSlideId = store.getSnapshot().activeSlideId;
      store.mutate(
        (document) => {
          const live = slideOf(document, activeSlideId)?.texts.find(
            (item) => item.id === textId,
          );
          if (live === undefined) return;
          change(live);
        },
        { history },
      );
    },
    [store, textId],
  );

  const rectOfText = useCallback((): LayerRect | null => {
    const state = store.getSnapshot();
    const live = state.project.slides
      .find((slide) => slide.id === state.activeSlideId)
      ?.texts.find((item) => item.id === textId);
    if (live === undefined) return null;
    return {
      x: live.x,
      y: live.y,
      width: live.width,
      height: live.height,
      rotation: live.rotation,
    };
  }, [store, textId]);

  const beginMove = useMoveGesture(context, { kind: "text" });

  const beginResize = useResizeGesture(context, {
    rect: rectOfText,
    // app.js:4038-4039 passes no preserveAspect for a text box at all, so a
    // corner stretches it the same way an edge does.
    limits: () => TEXT_RESIZE_LIMITS,
    apply: (next) => {
      writeText((live) => {
        live.x = next.x;
        live.y = next.y;
        live.width = next.width;
        live.height = next.height;
      });
    },
  });

  const beginRotate = useRotateGesture(context, {
    rect: rectOfText,
    apply: (rotation) => {
      writeText((live) => {
        live.rotation = rotation;
      });
    },
  });

  /*
   * ensureTextFits (app.js:2931-2947), without the DOM read.
   *
   * app.js cleared max-height, read scrollHeight and put max-height back, all
   * inside a requestAnimationFrame, because only the laid-out DOM knew how tall
   * the wrapped text was. TextLayout carries contentHeight, so the answer is
   * already here, and the measurement cannot disagree with the export's.
   *
   * It only ever grows, so deleting a word never collapses the box.
   */
  const lastText = useRef(layer.text);
  useEffect(() => {
    if (lastText.current === layer.text) return;
    lastText.current = layer.text;
    if (!stage.height) return;
    const needed = layout.contentHeight;
    if (needed <= layer.height * stage.height) return;
    const next = Math.min(1, needed / stage.height);
    if (next <= layer.height) return;
    writeText((live) => {
      live.height = next;
    });
  }, [layer.text, layer.height, layout.contentHeight, stage.height, writeText]);

  const isContentPress = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest("[data-text-content], [data-text-editor]") !== null;

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const contentPress = isContentPress(event.target);

      if (editing) {
        // A press inside the editor belongs to the editor, so the caret moves
        // rather than the layer (app.js:3821).
        if (contentPress) return;
        onEndEditing();
      } else if (
        /*
         * app.js:3823-3829, the deliberate two-step from commit 749e7f1: a
         * press on an unselected box only selects it, and a second press on
         * the glyphs of an already selected box starts editing.
         *
         * "Already selected" is carried by contentPress alone, and deliberately
         * so. Only the hit area and the editor answer that test, and the hit
         * area is rendered for a selected layer only, exactly as
         * styles.css:1798 gave `.text-content` its pointer events. app.js
         * checked the selection here as well; that second check could not fail
         * independently of the first, and a guard no test can kill is a guard
         * the next reader deletes without noticing. The render condition is
         * pinned instead, by "gives the glyphs no press of their own until the
         * layer is selected".
         */
        contentPress &&
        event.button === 0 &&
        !(event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onStartEditing(textId, {
          mode: "point",
          clientX: event.clientX,
          clientY: event.clientY,
        });
        return;
      }

      if (!prepareLayerPointerSelection(store, event, "text", textId)) return;
      if (store.getSnapshot().croppingOverlayId !== null) {
        onFinishCrop();
        return;
      }
      beginMove(event);
    },
    [beginMove, editing, onEndEditing, onFinishCrop, onStartEditing, store, textId],
  );

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editing || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onStartEditing(textId, { mode: "all" });
    },
    [editing, onStartEditing, textId],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelectedLayers(store);
        return;
      }
      /*
       * app.js:3860-3862 dispatched a synthetic dblclick here to reach the one
       * handler. The handler is a function now, so it is called directly.
       *
       * Only once the layer is selected, which mirrors the two-step a pointer
       * takes: the first Enter selects, through LayerBox's activation, and the
       * second opens the editor.
       */
      if (event.key === "Enter" && selected) {
        event.preventDefault();
        onStartEditing(textId, { mode: "all" });
      }
    },
    [editing, onStartEditing, selected, store, textId],
  );

  const clipStyle: CSSProperties = {
    clipPath: layerClipCss(layer.x, layer.y, layer.width, layer.height),
  };

  return (
    <LayerBox
      kind="text"
      id={textId}
      ref={box}
      x={layer.x}
      y={layer.y}
      width={layer.width}
      height={layer.height}
      rotation={layer.rotation}
      selected={selected}
      primary={primary}
      handles={handles}
      data-editing={editing ? "true" : undefined}
      aria-label={`Text layer: ${layer.text}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onActivate={() => {
        store.selectOnly("text", textId);
      }}
      onHandlePointerDown={(handle: Handle, event) => {
        event.stopPropagation();
        // app.js:3821. A handle pressed while the editor is open commits the
        // text first, so the box is resized rather than the caret moved.
        if (editing) onEndEditing();
        beginResize(handle, event);
      }}
      onRotatePointerDown={(event) => {
        event.stopPropagation();
        if (editing) onEndEditing();
        beginRotate(event);
      }}
    >
      {/*
       * styles.css:1744-1753. The overhang, greyed, shown only while the layer
       * is selected, so what will not export is visible while it is placed.
       * app.js kept this copy in the DOM and hid it; leaving it out entirely
       * halves the nodes a slide full of text costs.
       */}
      {selected ? (
        <div className={styles.outside} aria-hidden="true">
          {renderTextDom(layer, layout)}
        </div>
      ) : null}
      <div className={styles.inside} data-testid="text-inside" style={clipStyle}>
        <div aria-hidden={editing ? "true" : undefined}>
          {renderTextDom(layer, layout)}
        </div>
        {selected && !editing ? (
          /*
           * styles.css:1798. The glyphs themselves take the press that starts an
           * edit, and only while the layer is selected. Anywhere else in the box
           * drags the layer instead, which is what makes the two-step work.
           */
          <div
            className={styles.hitArea}
            data-text-content="true"
            data-testid="text-hit"
            style={textBlockStyle(layout)}
          />
        ) : null}
        {editing ? (
          <InlineTextEditor
            value={layer.text}
            layout={layout}
            caret={caret}
            onInput={(value) => {
              writeText((live) => {
                live.text = value;
              });
            }}
            onBlur={onEndEditing}
          />
        ) : null}
      </div>
    </LayerBox>
  );
}
