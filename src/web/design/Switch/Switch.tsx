import type { ComponentPropsWithoutRef } from "react";
import { Switch as Primitive } from "radix-ui";
import { useFieldControl } from "../Field/Field.js";
import styles from "./Switch.module.css";

/*
 * A two state control that applies immediately, which is the difference between
 * a switch and a checkbox. Radix gives it role="switch" and keeps aria-checked
 * in step, so a screen reader reports the state rather than the word "button".
 */

export type SwitchProps = Omit<
  ComponentPropsWithoutRef<typeof Primitive.Root>,
  "children"
>;

export function Switch({
  className,
  id,
  "aria-describedby": describedBy,
  ...rest
}: SwitchProps) {
  // Inside a Field the label, the id and the description are already decided.
  const field = useFieldControl();

  return (
    <Primitive.Root
      id={id ?? field?.controlId}
      className={[styles.track, className].filter(Boolean).join(" ")}
      aria-describedby={describedBy ?? field?.describedBy}
      {...rest}
    >
      <Primitive.Thumb className={styles.thumb} />
    </Primitive.Root>
  );
}
