import type { ComponentPropsWithoutRef } from "react";
import { Popover as Primitive } from "radix-ui";
import styles from "./Popover.module.css";

/*
 * A panel anchored to a control, for the things the old app put in a menu that
 * were never really menus: the custom ratio form at app.js:820-870, a colour
 * picker, a crop tuner. A menu row is a command; a popover holds a form.
 */

export type PopoverContentProps = ComponentPropsWithoutRef<typeof Primitive.Content>;

function Content({ className, sideOffset = 8, ...rest }: PopoverContentProps) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        className={[styles.content, className].filter(Boolean).join(" ")}
        sideOffset={sideOffset}
        {...rest}
      />
    </Primitive.Portal>
  );
}

export const Popover = {
  Root: Primitive.Root,
  Trigger: Primitive.Trigger,
  Anchor: Primitive.Anchor,
  Content,
  Close: Primitive.Close,
};
