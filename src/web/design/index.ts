/*
 * The design system's front door. Screens import from here, never from a
 * primitive's folder, so a primitive can be reshaped without a hunt.
 *
 * The Radix backed overlays, Select, Switch, Slider, and Tabs follow the
 * primitives that need no portal.
 */

export { Button } from "./Button/Button.js";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button/Button.js";

export { IconButton } from "./IconButton/IconButton.js";
export type {
  IconButtonProps,
  IconButtonSize,
  IconButtonVariant,
} from "./IconButton/IconButton.js";

export { Input } from "./Input/Input.js";
export type { InputProps, InputSize } from "./Input/Input.js";

export { Textarea } from "./Textarea/Textarea.js";
export type { TextareaProps } from "./Textarea/Textarea.js";

export { Field, useFieldControl } from "./Field/Field.js";
export type { FieldContextValue, FieldProps } from "./Field/Field.js";

export { Card } from "./Card/Card.js";
export type { CardPadding, CardProps } from "./Card/Card.js";

export { Badge } from "./Badge/Badge.js";
export type { BadgeProps, BadgeTone } from "./Badge/Badge.js";

export { Inline, Stack } from "./Layout/Layout.js";
export type {
  InlineProps,
  LayoutAlign,
  LayoutJustify,
  SpaceStep,
  StackProps,
} from "./Layout/Layout.js";

export { Icon, iconNames } from "./icons.js";
export type { IconName, IconProps } from "./icons.js";

export { Select } from "./Select/Select.js";
export type { SelectOption, SelectProps } from "./Select/Select.js";

export { Switch } from "./Switch/Switch.js";
export type { SwitchProps } from "./Switch/Switch.js";

export { Slider } from "./Slider/Slider.js";
export type { SliderProps } from "./Slider/Slider.js";

export { Dialog } from "./Dialog/Dialog.js";
export type {
  DialogActionsProps,
  DialogContentProps,
  DialogDescriptionProps,
  DialogTitleProps,
} from "./Dialog/Dialog.js";

export { Popover } from "./Popover/Popover.js";
export type { PopoverContentProps } from "./Popover/Popover.js";

export { DropdownMenu } from "./DropdownMenu/DropdownMenu.js";
export type {
  DropdownMenuCheckboxItemProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuLabelProps,
  DropdownMenuRadioItemProps,
  DropdownMenuSeparatorProps,
} from "./DropdownMenu/DropdownMenu.js";

export { ContextMenu } from "./ContextMenu/ContextMenu.js";
export type {
  ContextMenuCheckboxItemProps,
  ContextMenuContentProps,
  ContextMenuItemProps,
  ContextMenuLabelProps,
  ContextMenuRadioItemProps,
  ContextMenuSeparatorProps,
} from "./ContextMenu/ContextMenu.js";

export { Tooltip } from "./Tooltip/Tooltip.js";
export type { TooltipProps, TooltipProviderProps } from "./Tooltip/Tooltip.js";

export { Toast, ToastProvider, useToast } from "./Toast/Toast.js";
export type {
  ToastHandle,
  ToastOptions,
  ToastProps,
  ToastProviderProps,
  ToastTone,
} from "./Toast/Toast.js";

export { Tabs } from "./Tabs/Tabs.js";
export type {
  TabsContentProps,
  TabsListProps,
  TabsRootProps,
  TabsTriggerProps,
} from "./Tabs/Tabs.js";

/*
 * The menu row, outside a menu. A panel that has to sit beside a DropdownMenu and
 * read as the same object needs the row, not the menu semantics: the custom ratio
 * form of app.js:806 is a Popover whose rows have to match the presets next to it.
 * The stylesheet stays private, so the two menus and this row cannot drift.
 */
export { MenuRow, MenuSeparator } from "./menu/menu.js";
export type { MenuItemLook, MenuRowProps, MenuSeparatorProps } from "./menu/menu.js";
