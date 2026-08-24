import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Icon } from "../icons.js";
import type { IconName } from "../icons.js";
import styles from "./menu.module.css";

export { styles as menuStyles };

/*
 * Everything the five hand-rolled menus at app.js:641-932 could put on a row:
 * a leading glyph, a danger tint for a destructive action, and a muted tag on
 * the right for notes like "Suggested" or a ratio's aspect.
 */
export type MenuItemLook = {
  icon?: IconName;
  danger?: boolean;
  tag?: string;
};

export function menuItemClass(danger: boolean, className: string | undefined): string {
  return [styles.item, danger ? styles.danger : "", className].filter(Boolean).join(" ");
}

export type MenuItemBodyProps = {
  icon: IconName | undefined;
  tag: string | undefined;
  /* The Radix ItemIndicator for a checkbox or radio row, absent on a plain one. */
  indicator?: ReactNode;
  children: ReactNode;
};

export function MenuItemBody({ icon, tag, indicator, children }: MenuItemBodyProps) {
  return (
    <>
      {indicator === undefined ? null : (
        <span className={styles.indicator}>{indicator}</span>
      )}
      {icon === undefined ? null : <Icon name={icon} />}
      <span className={styles.label}>{children}</span>
      {tag === undefined ? null : <em className={styles.tag}>{tag}</em>}
    </>
  );
}

type MenuRowBase = MenuItemLook & {
  /* Draws the check. Implies the indicator column. */
  selected?: boolean;
  /* Reserves the indicator column on a row that is not selected, so a list lines up. */
  indicator?: boolean;
  children: ReactNode;
};

/*
 * The two arms are a real distinction, not a styling switch.
 *
 * A div row is a readout: a chosen value, a heading, a line of state. It cannot
 * take onClick, because a click handler on a div is a control the keyboard
 * cannot reach and a screen reader does not announce as actionable, and the row
 * paints cursor: default so it does not offer something it will not do.
 *
 * A button row is a control. It gets the pointer cursor, the focus ring, Enter
 * and Space, and disabled, because it is a real button.
 *
 * Refusing onClick on the div arm is the point: the affordance cannot be reached
 * without the element that honours it. Anyone reaching for a pickable row has to
 * write as="button", and the compiler says so.
 */
export type MenuRowProps =
  | (MenuRowBase &
      Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "onDoubleClick"> & {
        as?: "div";
        onClick?: never;
        onDoubleClick?: never;
      })
  | (MenuRowBase & ButtonHTMLAttributes<HTMLButtonElement> & { as: "button" });

/*
 * A menu row outside a menu.
 *
 * showRatioMenu (app.js:806) put radio rows and a custom-ratio form in one
 * panel. A Radix menu cannot hold a form, because arrow keys, typeahead and
 * select-to-close all fight one, so that panel splits into a DropdownMenu for
 * the presets and a Popover for the custom fields. This is what keeps the two
 * halves looking like one thing: the same row, the same reserved indicator
 * column, the same glyph and tag, with no menu semantics attached.
 */
export function MenuRow(props: MenuRowProps) {
  const {
    icon,
    tag,
    danger = false,
    selected = false,
    indicator = false,
    className,
    children,
    ...rest
  } = props;

  const showIndicator = selected || indicator;
  const body = (
    <MenuItemBody
      icon={icon}
      tag={tag}
      {...(showIndicator ? { indicator: selected ? <Icon name="check" /> : null } : {})}
    >
      {children}
    </MenuItemBody>
  );

  if (rest.as === "button") {
    const { as: _as, ...buttonProps } = rest;
    return (
      <button type="button" className={menuItemClass(danger, className)} {...buttonProps}>
        {body}
      </button>
    );
  }

  const { as: _as, ...divProps } = rest;
  return (
    <div
      className={[menuItemClass(danger, className), styles.static]
        .filter(Boolean)
        .join(" ")}
      {...divProps}
    >
      {body}
    </div>
  );
}

export type MenuSeparatorProps = HTMLAttributes<HTMLDivElement>;

/* The rule between two groups of rows, for the same panels MenuRow serves. */
export function MenuSeparator({ className, ...rest }: MenuSeparatorProps) {
  return (
    <div
      role="separator"
      className={[styles.separator, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
