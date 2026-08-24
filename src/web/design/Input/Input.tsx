import type { InputHTMLAttributes } from "react";
import { useFieldControl } from "../Field/Field.js";
import styles from "./Input.module.css";

export type InputSize = "sm" | "md";

/* `size` is a native input attribute, so the scale prop is named separately. */
export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  inputSize?: InputSize;
  invalid?: boolean;
};

export function Input({
  inputSize = "md",
  invalid,
  className,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: InputProps) {
  const field = useFieldControl();
  const resolvedInvalid = invalid ?? field?.invalid ?? false;

  const classes = [
    styles.input,
    resolvedInvalid ? styles.invalid : "",
    inputSize === "sm" ? styles.small : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <input
      id={id ?? field?.controlId}
      className={classes}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={ariaInvalid ?? (resolvedInvalid ? true : undefined)}
      {...rest}
    />
  );
}
