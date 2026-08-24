import type {
  ComponentPropsWithRef,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { layerStageInset } from "@shared/geometry/index.js";
import { Icon } from "../../../design/index.js";
import type { LayerKind } from "../selection.js";
import styles from "./LayerBox.module.css";

/*
 * The frame every layer is drawn in, with its selection outline, its eight
 * resize handles and its rotate handle. Ported from the shared shell of
 * renderOverlayBox (app.js:1819-1863) and renderTextBox (app.js:1865-1900), and
 * from styles.css:1579-2015.
 */

/** The eight resize handles, named by compass point (app.js:1851-1859). */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** The corners resize an overlay proportionally; the edges do not (app.js:3516-3517). */
export const CORNER_HANDLES: readonly Handle[] = ["nw", "ne", "sw", "se"];
export const EDGE_HANDLES: readonly Handle[] = ["n", "e", "s", "w"];

/** All eight, clockwise from the top left, the order app.js:1839-1846 lists them. */
export const ALL_HANDLES: readonly Handle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function isCornerHandle(handle: Handle): boolean {
  return handle.length === 2;
}

export type LayerBoxProps = Omit<
  ComponentPropsWithRef<"div">,
  "children" | "onPointerDown"
> & {
  kind: LayerKind;
  id: string;
  /** Position and size in canvas fractions, exactly as the document stores them. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  selected: boolean;
  /** The layer a multi-selection is anchored on (app.js:400-412). */
  primary: boolean;
  /** app.js:1986-1990 hides every handle while more than one layer is selected. */
  handles: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onHandlePointerDown: (handle: Handle, event: PointerEvent<HTMLElement>) => void;
  onRotatePointerDown: (event: PointerEvent<HTMLElement>) => void;
  /**
   * Enter or Space on a focused layer, which selects it the way a press does.
   *
   * `tabIndex` alone made every layer a Tab stop with nothing behind it, and a
   * Tab stop is a promise that something is operable there. A keyboard reader
   * could reach a layer and then reach nothing else: the inspector, the words,
   * the colour and the position all hang off a selection they had no way to
   * make. app.js had the same hole.
   */
  onActivate: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

/**
 * The CSS clip that hides the part of a layer hanging off the canvas
 * (app.js:529-532). The overhang is drawn a second time, greyed, so a selected
 * layer shows where it really reaches.
 */
export function layerClipCss(
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const inset = layerStageInset(x, y, width, height);
  return `inset(${String(inset.top * 100)}% ${String(inset.right * 100)}% ${String(
    inset.bottom * 100,
  )}% ${String(inset.left * 100)}%)`;
}

export function LayerBox({
  kind,
  id,
  x,
  y,
  width,
  height,
  rotation,
  selected,
  primary,
  handles,
  onPointerDown,
  onHandlePointerDown,
  onRotatePointerDown,
  onActivate,
  onKeyDown,
  className,
  style,
  children,
  ...rest
}: LayerBoxProps) {
  const boxStyle: CSSProperties = {
    left: `${String(x * 100)}%`,
    top: `${String(y * 100)}%`,
    width: `${String(width * 100)}%`,
    height: `${String(height * 100)}%`,
    transform: `rotate(${String(rotation)}deg)`,
    ...style,
  };

  /*
   * The layer's own keys first, so a text box can take Enter for its editor and
   * Delete for itself. Activation only runs on what is left.
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    // Space would scroll the workspace, and Enter would do nothing at all.
    event.preventDefault();
    onActivate(event);
  };

  return (
    <div
      className={[styles.box, selected ? styles.selected : "", className]
        .filter(Boolean)
        .join(" ")}
      // Stage's marquee hit-tests on these two, so they are a contract rather
      // than a debugging aid (Stage.tsx:33-36).
      data-layer-kind={kind}
      data-layer-id={id}
      data-selected={selected ? "true" : undefined}
      data-primary={primary ? "true" : undefined}
      style={boxStyle}
      tabIndex={0}
      /*
       * A bare div announces as a group, which says nothing about what pressing
       * it would do. `button` is the role whose contract this actually keeps:
       * focus it, press Enter or Space, something happens. `option` inside a
       * `listbox` would name the noun better, but that pattern owes the reader
       * arrow keys that move between options, and the arrows here move the
       * layer instead.
       */
      role="button"
      aria-pressed={selected}
      onPointerDown={onPointerDown}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
      {handles ? (
        <>
          <span
            className={styles.rotate}
            data-rotate="true"
            aria-hidden="true"
            onPointerDown={onRotatePointerDown}
          >
            <Icon name="rotate" />
          </span>
          {EDGE_HANDLES.map((handle) => (
            <span
              key={handle}
              className={styles.edge}
              data-handle={handle}
              aria-hidden="true"
              onPointerDown={(event) => {
                onHandlePointerDown(handle, event);
              }}
            />
          ))}
          {CORNER_HANDLES.map((handle) => (
            <span
              key={handle}
              className={styles.corner}
              data-handle={handle}
              aria-hidden="true"
              onPointerDown={(event) => {
                onHandlePointerDown(handle, event);
              }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
