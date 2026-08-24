import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ContextMenu as Primitive } from "radix-ui";
import { MenuItemBody, menuItemClass, menuStyles } from "../menu/menu.js";
import type { MenuItemLook } from "../menu/menu.js";
import { Icon } from "../icons.js";
import styles from "./ContextMenu.module.css";

/*
 * The same menu as DropdownMenu behind the other trigger the old app needed.
 * showLayerMenu and showSlideMenu both ran off contextmenu and read event.clientX
 * and clientY to place themselves; Radix anchors at the pointer for us, and it
 * does the long press on touch as well, which none of the five ever did.
 */

export type ContextMenuContentProps = ComponentPropsWithoutRef<
  typeof Primitive.Content
> & {
  /* The narrow menu of .layer-menu--confirm, one or two rows wide. */
  compact?: boolean;
};

function Content({ compact = false, className, ...rest }: ContextMenuContentProps) {
  const classes = [
    menuStyles.content,
    styles.content,
    compact ? styles.compact : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Primitive.Portal>
      <Primitive.Content className={classes} {...rest} />
    </Primitive.Portal>
  );
}

export type ContextMenuItemProps = ComponentPropsWithoutRef<typeof Primitive.Item> &
  MenuItemLook & { children: ReactNode };

function Item({
  icon,
  tag,
  danger = false,
  className,
  children,
  ...rest
}: ContextMenuItemProps) {
  return (
    <Primitive.Item className={menuItemClass(danger, className)} {...rest}>
      <MenuItemBody icon={icon} tag={tag}>
        {children}
      </MenuItemBody>
    </Primitive.Item>
  );
}

export type ContextMenuCheckboxItemProps = ComponentPropsWithoutRef<
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
}: ContextMenuCheckboxItemProps) {
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

export type ContextMenuRadioItemProps = ComponentPropsWithoutRef<
  typeof Primitive.RadioItem
> &
  MenuItemLook & { children: ReactNode };

function RadioItem({
  icon,
  tag,
  danger = false,
  className,
  children,
  ...rest
}: ContextMenuRadioItemProps) {
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

export type ContextMenuSeparatorProps = ComponentPropsWithoutRef<
  typeof Primitive.Separator
>;

function Separator({ className, ...rest }: ContextMenuSeparatorProps) {
  return (
    <Primitive.Separator
      className={[menuStyles.separator, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type ContextMenuLabelProps = ComponentPropsWithoutRef<typeof Primitive.Label>;

function Label({ className, ...rest }: ContextMenuLabelProps) {
  return (
    <Primitive.Label
      className={[menuStyles.groupLabel, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export const ContextMenu = {
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
