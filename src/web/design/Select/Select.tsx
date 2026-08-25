import type { ComponentPropsWithRef, ComponentPropsWithoutRef } from "react";
import { Select as Primitive } from "radix-ui";
import { useFieldControl } from "../Field/Field.js";
import { Icon } from "../icons.js";
import { menuStyles } from "../menu/menu.js";
import styles from "./Select.module.css";

/*
 * A native select cannot be styled to match this app's controls, and the old
 * code worked around that with the ratio and preview menus at app.js:806 and
 * :908, which were selects wearing a menu's clothes. This is the real control:
 * one value, a listbox, and type ahead.
 */

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type PrimitiveRootProps = ComponentPropsWithoutRef<typeof Primitive.Root>;

/*
 * The trigger's props are the base, so id, className, data-*, aria-*, ref and
 * every DOM handler reach the button a caller can actually see and point at.
 * The Root's own props are picked by name on top of that.
 *
 * Placement is deliberately not exposed: Radix flips the list on collision by
 * itself, and a select that opens upward because a caller said so rather than
 * because it had to is a select that opens upward in the wrong place.
 */
export type SelectProps = Omit<
  ComponentPropsWithRef<typeof Primitive.Trigger>,
  "children" | "value" | "defaultValue" | "dir"
> &
  Pick<
    PrimitiveRootProps,
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "required"
    | "name"
    | "open"
    | "defaultOpen"
    | "onOpenChange"
    | "dir"
  > & {
    /*
     * The options as data rather than children. Every select in this app is a
     * flat list, and passing data means a caller cannot put something in the
     * listbox that is not an option.
     */
    items: readonly SelectOption[];
    /* Shown until something is chosen. Without one an empty select looks broken. */
    placeholder?: string;
  };

export function Select({
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose",
  disabled,
  required,
  name,
  open,
  defaultOpen,
  onOpenChange,
  dir,
  className,
  ...trigger
}: SelectProps) {
  const field = useFieldControl();
  const invalid = field?.invalid ?? false;

  return (
    <Primitive.Root
      // exactOptionalPropertyTypes refuses an explicit undefined on each of
      // these, and a value key present with no value makes the select controlled
      // at nothing.
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(required === undefined ? {} : { required })}
      {...(name === undefined ? {} : { name })}
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      {...(dir === undefined ? {} : { dir })}
    >
      <Primitive.Trigger
        id={field?.controlId}
        className={[styles.trigger, invalid ? styles.invalid : "", className]
          .filter(Boolean)
          .join(" ")}
        aria-describedby={field?.describedBy}
        aria-invalid={invalid ? true : undefined}
        {...trigger}
      >
        <Primitive.Value placeholder={placeholder} />
        <Primitive.Icon asChild>
          <Icon name="down" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        {/*
         * position="popper" anchors the list below the trigger. Radix's default
         * lays the chosen item over the trigger instead, which reads as a native
         * macOS menu and nothing else in this app behaves that way.
         */}
        <Primitive.Content
          className={[menuStyles.content, styles.content].filter(Boolean).join(" ")}
          position="popper"
          sideOffset={6}
        >
          <Primitive.Viewport>
            {items.map((item) => (
              <Primitive.Item
                key={item.value}
                value={item.value}
                className={menuStyles.item}
                {...(item.disabled === undefined ? {} : { disabled: item.disabled })}
              >
                <span className={menuStyles.indicator}>
                  <Primitive.ItemIndicator>
                    <Icon name="check" />
                  </Primitive.ItemIndicator>
                </span>
                <Primitive.ItemText>
                  <span className={menuStyles.label}>{item.label}</span>
                </Primitive.ItemText>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
