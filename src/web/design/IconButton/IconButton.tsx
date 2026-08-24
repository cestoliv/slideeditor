import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "../icons.js";
import type { IconName } from "../icons.js";
import styles from "./IconButton.module.css";

export type IconButtonVariant = "outline" | "plain" | "danger";
export type IconButtonSize = "sm" | "md";

type IconButtonBase = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label" | "title"
> & {
  /* The glyph carries no text, so the label is the whole accessible name. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
};

/*
 * Either a glyph from the icon map or an arbitrary child, never both. Not every
 * mark is line art: the AirDrop share icon and the GitHub mark ship as images.
 */
export type IconButtonProps = IconButtonBase &
  ({ icon: IconName; children?: never } | { icon?: never; children: ReactNode });

const variantClass: Record<IconButtonVariant, string> = {
  outline: "",
  plain: styles.plain ?? "",
  danger: styles.danger ?? "",
};

export function IconButton(props: IconButtonProps) {
  const {
    icon,
    label,
    variant = "outline",
    size = "md",
    className,
    type = "button",
    children,
    ...rest
  } = props;

  const classes = [
    styles.iconButton,
    variantClass[variant],
    size === "sm" ? styles.small : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      // The native tooltip is the hover affordance until Tooltip wraps this.
      title={label}
      {...rest}
    >
      {icon === undefined ? children : <Icon name={icon} />}
    </button>
  );
}
