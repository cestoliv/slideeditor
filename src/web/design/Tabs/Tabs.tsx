import type { ComponentPropsWithoutRef } from "react";
import { Tabs as Primitive } from "radix-ui";
import styles from "./Tabs.module.css";

/*
 * The old app had no tabs; the inspector rails switched with plain buttons and a
 * hidden div, so nothing tied a control to the panel it governed. Radix wires the
 * roving tabindex, the aria-controls pair, and the arrow keys.
 */

export type TabsRootProps = ComponentPropsWithoutRef<typeof Primitive.Root>;

function Root({ className, ...rest }: TabsRootProps) {
  return (
    <Primitive.Root
      className={[styles.root, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type TabsListProps = ComponentPropsWithoutRef<typeof Primitive.List>;

function List({ className, ...rest }: TabsListProps) {
  return (
    <Primitive.List
      className={[styles.list, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type TabsTriggerProps = ComponentPropsWithoutRef<typeof Primitive.Trigger>;

function Trigger({ className, ...rest }: TabsTriggerProps) {
  return (
    <Primitive.Trigger
      className={[styles.trigger, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type TabsContentProps = ComponentPropsWithoutRef<typeof Primitive.Content>;

function Content({ className, ...rest }: TabsContentProps) {
  return (
    <Primitive.Content
      className={[styles.content, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export const Tabs = { Root, List, Trigger, Content };
