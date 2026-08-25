import type { ComponentPropsWithoutRef, HTMLAttributes } from "react";
import { Dialog as Primitive } from "radix-ui";
import styles from "./Dialog.module.css";

/*
 * The modal, ported from .modal-backdrop and .modal at styles.css:2551-2615.
 * Radix owns the focus trap, the Escape handler, the scroll lock, and the return
 * of focus to the trigger, which the old showModal did none of.
 */

export type DialogContentProps = ComponentPropsWithoutRef<typeof Primitive.Content> & {
  /* The narrower confirmation modal of .modal--confirm, styles.css:2586. */
  compact?: boolean;
};

function Content({ compact = false, className, ...rest }: DialogContentProps) {
  const classes = [styles.content, compact ? styles.compact : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <Primitive.Portal>
      <Primitive.Overlay className={styles.overlay} />
      <Primitive.Content className={classes} {...rest} />
    </Primitive.Portal>
  );
}

export type DialogTitleProps = ComponentPropsWithoutRef<typeof Primitive.Title>;

function Title({ className, ...rest }: DialogTitleProps) {
  return (
    <Primitive.Title
      className={[styles.title, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type DialogDescriptionProps = ComponentPropsWithoutRef<
  typeof Primitive.Description
>;

function Description({ className, ...rest }: DialogDescriptionProps) {
  return (
    <Primitive.Description
      className={[styles.description, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type DialogActionsProps = HTMLAttributes<HTMLDivElement>;

/* The trailing button row of .modal-actions, styles.css:2610. */
function Actions({ className, ...rest }: DialogActionsProps) {
  return (
    <div className={[styles.actions, className].filter(Boolean).join(" ")} {...rest} />
  );
}

export const Dialog = {
  Root: Primitive.Root,
  Trigger: Primitive.Trigger,
  Content,
  Title,
  Description,
  Actions,
  Close: Primitive.Close,
};
