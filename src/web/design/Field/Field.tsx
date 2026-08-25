import { createContext, useContext, useId } from "react";
import type { ReactNode } from "react";
import styles from "./Field.module.css";

export type FieldContextValue = {
  controlId: string;
  /* Space separated ids for the hint and the error, in the order to announce them. */
  describedBy: string | undefined;
  invalid: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/*
 * Controls read their id, description, and invalid state from here instead of
 * the caller wiring three attributes by hand on every form in the app.
 */
export function useFieldControl(): FieldContextValue | null {
  return useContext(FieldContext);
}

export type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  /* Pass this only when the control owns an id the field cannot generate. */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, htmlFor, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;

  // The error comes first so a screen reader reaches the problem before the advice.
  const describedBy =
    [error === undefined ? "" : errorId, hint === undefined ? "" : hintId]
      .filter(Boolean)
      .join(" ") || undefined;

  const classes = [styles.field, className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
      </label>
      <FieldContext.Provider
        value={{ controlId, describedBy, invalid: error !== undefined }}
      >
        {children}
      </FieldContext.Provider>
      {hint === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
