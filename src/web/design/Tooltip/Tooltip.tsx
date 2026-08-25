import { cloneElement, createContext, isValidElement, useContext } from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Tooltip as Primitive } from "radix-ui";
import styles from "./Tooltip.module.css";

/*
 * The upgrade path for every title attribute in the old app. A native title
 * waits about a second, cannot be styled, is invisible to touch, and never
 * appears for a keyboard user. This one shows on hover and on focus, and the
 * label reaches assistive technology whether it opens or not.
 */

/*
 * Radix requires a Provider above every tooltip. Rather than make the app
 * remember, a Tooltip mounts its own when none is above it. Mounting one at the
 * app root is still worth doing: it is what lets the second tooltip in a row
 * skip the delay.
 */
const HasProvider = createContext(false);

export type TooltipProviderProps = ComponentPropsWithoutRef<typeof Primitive.Provider>;

function Provider({ children, ...rest }: TooltipProviderProps) {
  return (
    <HasProvider.Provider value={true}>
      <Primitive.Provider {...rest}>{children}</Primitive.Provider>
    </HasProvider.Provider>
  );
}

export type TooltipProps = Omit<
  ComponentPropsWithoutRef<typeof Primitive.Root>,
  "children"
> & {
  /* The label. Keep it to a phrase; a tooltip that needs a paragraph is a popover. */
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /*
   * One element, and it must take a ref and spread props, because the trigger is
   * the child itself. Wrapping in an extra span would put a second element in the
   * tab order and change the layout around it.
   */
  children: ReactElement;
};

/*
 * A trigger that still carries a title attribute shows the browser's own tooltip
 * beside this one, and the native one cannot be styled, reached by keyboard, or
 * seen on touch. IconButton sets title from its label, which is the right hover
 * affordance right up until a Tooltip wraps it, so the Tooltip clears it rather
 * than every caller having to remember.
 *
 * The clone reaches an inner title too: a component that spreads its remaining
 * props onto the element it renders passes this one straight through.
 */
function withoutNativeTitle(children: ReactElement): ReactElement {
  if (!isValidElement<{ title?: string | undefined }>(children)) return children;
  return cloneElement(children, { title: undefined });
}

function TooltipRoot({
  content,
  side = "top",
  align = "center",
  sideOffset = 6,
  delayDuration = 300,
  children,
  ...root
}: TooltipProps) {
  const hasProvider = useContext(HasProvider);

  const tooltip = (
    <Primitive.Root delayDuration={delayDuration} {...root}>
      <Primitive.Trigger asChild>{withoutNativeTitle(children)}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className={styles.content}
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          {content}
          <Primitive.Arrow className={styles.arrow} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );

  return hasProvider ? tooltip : <Primitive.Provider>{tooltip}</Primitive.Provider>;
}

export const Tooltip = Object.assign(TooltipRoot, { Provider });
