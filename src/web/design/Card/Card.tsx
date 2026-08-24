import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

export type CardPadding = "none" | "sm" | "md" | "lg";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  padding?: CardPadding;
  /* Interactive cards lift on hover. The caller still owns the click target. */
  interactive?: boolean;
};

const paddingClass: Record<CardPadding, string> = {
  none: "",
  sm: styles.paddingSm ?? "",
  md: styles.paddingMd ?? "",
  lg: styles.paddingLg ?? "",
};

export function Card({
  padding = "md",
  interactive = false,
  className,
  ...rest
}: CardProps) {
  const classes = [
    styles.card,
    paddingClass[padding],
    interactive ? styles.interactive : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes} {...rest} />;
}
