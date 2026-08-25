import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Toast as Primitive } from "radix-ui";
import styles from "./Toast.module.css";

/*
 * The pill from styles.css:3065, driven the way app.js:1147 drove it: call a
 * function with a string. What is new is that the message reaches a screen
 * reader, that a second toast queues instead of deleting the first, and that
 * hovering pauses the timer.
 */

/* app.js:1154. Long enough to read a sentence, short enough not to sit there. */
const TOAST_DURATION = 2600;

export type ToastTone = "neutral" | "danger";

export type ToastOptions = {
  tone?: ToastTone;
  /* Milliseconds. Pass Infinity for a toast the reader has to dismiss. */
  duration?: number;
};

export type ToastHandle = {
  /* Returns the id, so a long running message can be dismissed when its work ends. */
  toast: (message: ReactNode, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastHandle | null>(null);

export function useToast(): ToastHandle {
  const handle = useContext(ToastContext);
  if (handle === null) {
    throw new Error("useToast needs a <ToastProvider> above it.");
  }
  return handle;
}

export type ToastProps = Omit<ComponentPropsWithoutRef<typeof Primitive.Root>, "type"> & {
  tone?: ToastTone;
  /*
   * altText is what a screen reader is told to do when it cannot reach the
   * button, so it names the equivalent path rather than repeating the label.
   */
  action?: { label: string; altText: string; onSelect: () => void };
  children: ReactNode;
};

export function Toast({
  tone = "neutral",
  action,
  className,
  children,
  duration = TOAST_DURATION,
  ...rest
}: ToastProps) {
  const classes = [styles.toast, tone === "danger" ? styles.danger : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    /*
     * type="background" is what makes the announcement polite. Radix's default,
     * "foreground", is assertive, which interrupts whatever the reader is saying.
     * A toast reports something that already happened, so it can wait its turn.
     */
    <Primitive.Root className={classes} type="background" duration={duration} {...rest}>
      <Primitive.Description className={styles.message}>{children}</Primitive.Description>
      {action === undefined ? null : (
        <Primitive.Action
          className={styles.action}
          altText={action.altText}
          onClick={action.onSelect}
        >
          {action.label}
        </Primitive.Action>
      )}
    </Primitive.Root>
  );
}

type QueuedToast = {
  id: string;
  message: ReactNode;
  tone: ToastTone;
  duration: number;
};

export type ToastProviderProps = {
  children: ReactNode;
  /* What a screen reader says before the message. Radix defaults to "Notification". */
  label?: string;
};

export function ToastProvider({ children, label = "Notification" }: ToastProviderProps) {
  const [queue, setQueue] = useState<readonly QueuedToast[]>([]);
  // An id has to be unique across the session, and a render must not mint one.
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((message: ReactNode, options?: ToastOptions) => {
    nextId.current += 1;
    const id = `toast-${String(nextId.current)}`;
    setQueue((current) => [
      ...current,
      {
        id,
        message,
        tone: options?.tone ?? "neutral",
        duration: options?.duration ?? TOAST_DURATION,
      },
    ]);
    return id;
  }, []);

  const handle = useMemo<ToastHandle>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={handle}>
      <Primitive.Provider label={label} swipeDirection="right">
        {children}
        {queue.map((item) => (
          <Toast
            key={item.id}
            tone={item.tone}
            duration={item.duration}
            open
            onOpenChange={(open) => {
              // Radix closes on the timer, the swipe, and the close button alike,
              // so dropping the entry here covers every route out.
              if (!open) dismiss(item.id);
            }}
          >
            {item.message}
          </Toast>
        ))}
        <Primitive.Viewport className={styles.viewport} />
      </Primitive.Provider>
    </ToastContext.Provider>
  );
}
