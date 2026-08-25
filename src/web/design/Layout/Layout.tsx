import type { ElementType, HTMLAttributes } from "react";
import styles from "./Layout.module.css";

/* Steps on the space scale. A layout cannot ask for a gap the scale lacks. */
export type SpaceStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type LayoutAlign = "start" | "center" | "end" | "stretch" | "baseline";
export type LayoutJustify = "start" | "center" | "end" | "between";

type LayoutProps = HTMLAttributes<HTMLElement> & {
  /* Renders a different tag when the region is a nav, a list, or a section. */
  as?: ElementType;
  gap?: SpaceStep;
  align?: LayoutAlign;
  justify?: LayoutJustify;
};

export type StackProps = LayoutProps;
export type InlineProps = LayoutProps & { wrap?: boolean };

export function Stack({
  as: Tag = "div",
  gap = 3,
  align,
  justify,
  className,
  ...rest
}: StackProps) {
  const classes = [styles.flex, styles.stack, className].filter(Boolean).join(" ");
  return (
    <Tag
      className={classes}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      {...rest}
    />
  );
}

export function Inline({
  as: Tag = "div",
  gap = 2,
  align = "center",
  justify,
  wrap = false,
  className,
  ...rest
}: InlineProps) {
  const classes = [styles.flex, styles.inline, wrap ? styles.wrap : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag
      className={classes}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      {...rest}
    />
  );
}
