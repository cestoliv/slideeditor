import type { ComponentPropsWithoutRef } from "react";
import { Slider as Primitive } from "radix-ui";
import { useFieldControl } from "../Field/Field.js";
import styles from "./Slider.module.css";

/*
 * Ported from input[type="range"] at styles.css:2494-2512. Radix carries the
 * arrow keys, Home and End, the clamping, and the aria-valuenow the native
 * element only half provided once it was restyled.
 */

type PrimitiveRootProps = ComponentPropsWithoutRef<typeof Primitive.Root>;

/*
 * Radix models a slider as an array of thumbs. Every slider in this app is one
 * value, so the array stops at this boundary rather than spreading through every
 * caller. A range slider would be a second component, not a prop on this one.
 */
export type SliderProps = Omit<
  PrimitiveRootProps,
  "value" | "defaultValue" | "onValueChange" | "onValueCommit" | "children"
> & {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /* Fires once the drag ends, which is where an expensive re-render belongs. */
  onValueCommit?: (value: number) => void;
};

export function Slider({
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  className,
  id,
  min = 0,
  max = 100,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": describedBy,
  ...rest
}: SliderProps) {
  const field = useFieldControl();

  return (
    <Primitive.Root
      className={[styles.root, className].filter(Boolean).join(" ")}
      min={min}
      max={max}
      // exactOptionalPropertyTypes refuses an explicit undefined here, and a
      // value key present with no value would make the slider controlled at NaN.
      {...(value === undefined ? {} : { value: [value] })}
      {...(defaultValue === undefined ? {} : { defaultValue: [defaultValue] })}
      onValueChange={(next) => {
        onValueChange?.(next[0] ?? min);
      }}
      onValueCommit={(next) => {
        onValueCommit?.(next[0] ?? min);
      }}
      {...rest}
    >
      <Primitive.Track className={styles.track}>
        <Primitive.Range className={styles.range} />
      </Primitive.Track>
      {/*
       * The thumb is the element that carries role="slider" and aria-valuenow, so
       * the name and the description belong on it. On the root they would label a
       * group and the value would be announced with no name at all.
       */}
      <Primitive.Thumb
        className={styles.thumb}
        id={id ?? field?.controlId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={describedBy ?? field?.describedBy}
      />
    </Primitive.Root>
  );
}
