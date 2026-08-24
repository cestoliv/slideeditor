import { useCallback } from "react";
import type { ReactNode } from "react";
import { ContextMenu } from "../../../design/index.js";
import type { EditorStore } from "../store.js";
import { isLayerSelected } from "../selection.js";
import type { LayerKind, LayerMove } from "../selection.js";
import { deleteSelectedLayers } from "./actions.js";
import styles from "./LayerMenu.module.css";

/*
 * The right-click menu on a layer. Ported from showLayerMenu (app.js:641-682).
 *
 * app.js built the menu by hand, placed it at the pointer with
 * positionLayerMenu, and closed it from a document listener. Radix does the
 * placement, the dismissal and the long press on touch, so what is left here is
 * the five actions and the rule about which of them appear.
 */

export type LayerMenuProps = {
  store: EditorStore;
  kind: LayerKind;
  id: string;
  /** app.js:653. Crop is offered for one overlay on its own, never for a group. */
  canCrop: boolean;
  onCrop: (id: string) => void;
  children: ReactNode;
};

const MOVES: readonly {
  action: LayerMove;
  icon: "front" | "up" | "down" | "send-back";
  label: string;
}[] = [
  { action: "front", icon: "front", label: "Bring to front" },
  { action: "up", icon: "up", label: "Bring up a level" },
  { action: "down", icon: "down", label: "Bring down a level" },
  { action: "back", icon: "send-back", label: "Bring to back" },
];

export function LayerMenu({
  store,
  kind,
  id,
  canCrop,
  onCrop,
  children,
}: LayerMenuProps) {
  // app.js:646. Opening the menu on a layer outside the selection selects it,
  // so the actions below always describe what the reader is pointing at.
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) return;
      if (isLayerSelected(store.getSnapshot().selection, kind, id)) return;
      queueMicrotask(() => {
        store.selectOnly(kind, id);
      });
    },
    [id, kind, store],
  );

  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      {/*
       * The trigger wraps the layer in an element of its own rather than
       * merging into it. Radix composes its handlers into the child it is
       * given, and a component child would have to forward them by hand, which
       * is a silent break the moment one of them is missed. `display: contents`
       * keeps the wrapper out of the layout entirely.
       */}
      <ContextMenu.Trigger asChild>
        <div className={styles.trigger}>{children}</div>
      </ContextMenu.Trigger>
      {/*
       * Radix portals the panel to document.body, but it stays a descendant in
       * the React tree, and React propagates along that tree rather than the
       * DOM. So a press on a row reaches Stage's beginMarquee, which clears the
       * selection and captures the pointer on the workspace surface — after
       * which pointerup retargets there and the row never fires. Measured: a
       * press on a row took the selection from one layer to none and captured
       * the pointer.
       *
       * data-canvas-actions is the exclusion isInteractiveTarget already
       * honours (Stage.tsx:85), and it needs no change to Stage.
       */}
      <ContextMenu.Content aria-label="Layer actions" data-canvas-actions="">
        {canCrop ? (
          <ContextMenu.Item
            icon="crop"
            onSelect={() => {
              onCrop(id);
            }}
          >
            Crop
          </ContextMenu.Item>
        ) : null}
        {MOVES.map(({ action, icon, label }) => (
          <ContextMenu.Item
            key={action}
            icon={icon}
            onSelect={() => {
              store.moveLayer(kind, id, action);
            }}
          >
            {label}
          </ContextMenu.Item>
        ))}
        <ContextMenu.Item
          icon="trash"
          danger
          onSelect={() => {
            deleteSelectedLayers(store);
          }}
        >
          Remove
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
