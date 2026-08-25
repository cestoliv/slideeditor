import type { ButtonHTMLAttributes, MouseEvent } from "react";
import { Slot } from "radix-ui";
import styles from "./Button.module.css";

export type ButtonVariant = "solid" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type ButtonBase = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /* Busy means the button's own work is in flight, so a second press is dropped. */
  busy?: boolean;
};

/*
 * asChild renders the child element with the button's treatment instead of a
 * <button>, which is how a link takes the look without losing its href, its
 * middle-click, or its context menu.
 *
 * `disabled`, `aria-disabled` and `type` are refused on that arm rather than
 * silently ignored. An anchor honours none of them, so `<Button asChild disabled>`
 * would have rendered a live link that only looked dead, and a hand-written
 * `aria-disabled` would have announced one that is still navigable. Use `busy`
 * instead: it sets aria-disabled *and* calls preventDefault, which does stop a
 * navigation, so the announcement and the behaviour cannot drift apart.
 */
export type ButtonProps = ButtonBase &
  (
    | { asChild?: false }
    | { asChild: true; disabled?: never; type?: never; "aria-disabled"?: never }
  );

const variantClass: Record<ButtonVariant, string> = {
  solid: styles.solid ?? "",
  outline: styles.outline ?? "",
  ghost: styles.ghost ?? "",
  danger: styles.danger ?? "",
};

export function Button(props: ButtonProps) {
  const {
    variant = "outline",
    size = "md",
    busy = false,
    asChild = false,
    className,
    type = "button",
    onClick,
    ...rest
  } = props;

  const classes = [
    styles.button,
    variantClass[variant],
    size === "sm" ? styles.small : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A busy control stays focusable, so the guard lives here rather than in
    // `disabled`. preventDefault also stops an asChild anchor from navigating.
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const Component = asChild ? Slot.Root : "button";

  return (
    <Component
      // `type` is meaningless on an anchor and invalid in the DOM, so it only
      // goes on a real button.
      type={asChild ? undefined : type}
      className={classes}
      aria-busy={busy ? true : undefined}
      aria-disabled={busy ? true : undefined}
      onClick={handleClick}
      {...rest}
    />
  );
}
