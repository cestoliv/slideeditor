import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { DropdownMenu as Primitive } from "radix-ui";
import { MenuItemBody, menuItemClass, menuStyles } from "../menu/menu.js";
import type { MenuItemLook } from "../menu/menu.js";
import { Icon } from "../icons.js";
import styles from "./DropdownMenu.module.css";

/*
 * The replacement for showLayerMenu, showSlideMenu, showProjectMenu,
 * showRatioMenu and showPreviewMenu (app.js:641-932). Each of those five built a
 * div, appended it to the body, and positioned it by hand, so none of them
 * trapped focus, answered an arrow key, or closed on Escape. Radix does all of
 * that; what stays local is the paint and the row anatomy.
 */

export type DropdownMenuContentProps = ComponentPropsWithoutRef<
  typeof Primitive.Content
> & {
  /* The narrow menu of .layer-menu--confirm, one or two rows wide. */
  compact?: boolean;
};

function Content({
  compact = false,
  className,
  sideOffset = 6,
  ...rest
}: DropdownMenuContentProps) {
  const classes = [
    menuStyles.content,
    styles.content,
    compact ? styles.compact : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // The portal keeps the menu out of any ancestor's overflow or transform, which
  // is the reason the legacy menus appended to document.body by hand.
  return (
    <Primitive.Portal>
      <Primitive.Content className={classes} sideOffset={sideOffset} {...rest} />
    </Primitive.Portal>
  );
}

export type DropdownMenuItemProps = ComponentPropsWithoutRef<typeof Primitive.Item> &
  MenuItemLook & { children: ReactNode };

function Item({
  icon,
  tag,
  danger = false,
  className,
  children,
  ...rest
}: DropdownMenuItemProps) {
  return (
    <Primitive.Item className={menuItemClass(danger, className)} {...rest}>
      <MenuItemBody icon={icon} tag={tag}>
        {children}
      </MenuItemBody>
    </Primitive.Item>
  );
}

export type DropdownMenuCheckboxItemProps = ComponentPropsWithoutRef<
  typeof Primitive.CheckboxItem
> &
  MenuItemLook & { children: ReactNode };

function CheckboxItem({
  icon,
  tag,
  danger = false,
  className,
  children,
  ...rest
}: DropdownMenuCheckboxItemProps) {
  return (
    <Primitive.CheckboxItem className={menuItemClass(danger, className)} {...rest}>
      <MenuItemBody
        icon={icon}
        tag={tag}
        indicator={
          <Primitive.ItemIndicator>
            <Icon name="check" />
          </Primitive.ItemIndicator>
        }
      >
        {children}
      </MenuItemBody>
    </Primitive.CheckboxItem>
  );
}

export type DropdownMenuRadioItemProps = ComponentPropsWithoutRef<
  typeof Primitive.RadioItem
> &
  MenuItemLook & { children: ReactNode };

/*
 * showRatioMenu and showPreviewMenu were radio groups in all but name: they set
 * role="menuitemradio" and aria-checked by hand on plain buttons. This is that,
 * with the roving highlight and the checked state Radix maintains.
 */
function RadioItem({
  icon,
  tag,
  danger = false,
  className,
  children,
  ...rest
}: DropdownMenuRadioItemProps) {
  return (
    <Primitive.RadioItem className={menuItemClass(danger, className)} {...rest}>
      <MenuItemBody
        icon={icon}
        tag={tag}
        indicator={
          <Primitive.ItemIndicator>
            <Icon name="check" />
          </Primitive.ItemIndicator>
        }
      >
        {children}
      </MenuItemBody>
    </Primitive.RadioItem>
  );
}

export type DropdownMenuSeparatorProps = ComponentPropsWithoutRef<
  typeof Primitive.Separator
>;

function Separator({ className, ...rest }: DropdownMenuSeparatorProps) {
  return (
    <Primitive.Separator
      className={[menuStyles.separator, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type DropdownMenuLabelProps = ComponentPropsWithoutRef<typeof Primitive.Label>;

function Label({ className, ...rest }: DropdownMenuLabelProps) {
  return (
    <Primitive.Label
      className={[menuStyles.groupLabel, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export const DropdownMenu = {
  Root: Primitive.Root,
  Trigger: Primitive.Trigger,
  Content,
  Item,
  CheckboxItem,
  RadioGroup: Primitive.RadioGroup,
  RadioItem,
  Group: Primitive.Group,
  Label,
  Separator,
};
