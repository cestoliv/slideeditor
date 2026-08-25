import type { TextareaHTMLAttributes } from "react";
import { useFieldControl } from "../Field/Field.js";
import styles from "./Textarea.module.css";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function Textarea({
  invalid,
  className,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: TextareaProps) {
  const field = useFieldControl();
  const resolvedInvalid = invalid ?? field?.invalid ?? false;

  const classes = [styles.textarea, resolvedInvalid ? styles.invalid : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <textarea
      id={id ?? field?.controlId}
      className={classes}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={ariaInvalid ?? (resolvedInvalid ? true : undefined)}
      {...rest}
    />
  );
}
