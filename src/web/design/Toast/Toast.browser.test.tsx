import { useEffect, useRef } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "../Button/Button.js";
import { ToastProvider, useToast } from "./Toast.js";
import type { ToastOptions } from "./Toast.js";

function Publisher({ message, options }: { message: string; options?: ToastOptions }) {
  const { toast } = useToast();
  return (
    <Button
      onClick={() => {
        toast(message, options);
      }}
    >
      Publish
    </Button>
  );
}

function Harness({ message, options }: { message: string; options?: ToastOptions }) {
  return (
    <ToastProvider>
      <Publisher message={message} {...(options === undefined ? {} : { options })} />
    </ToastProvider>
  );
}

it("shows the message the caller asked for", async () => {
  const screen = await render(<Harness message="Slides are now 9:16" />);
  await screen.getByRole("button", { name: "Publish" }).click();
  await expect.element(toastSaying(screen, "Slides are now 9:16")).toBeVisible();
});

it("announces politely rather than interrupting the reader", async () => {
  const screen = await render(<Harness message="Project saved" />);
  await screen.getByRole("button", { name: "Publish" }).click();
  // Radix defaults a toast to type="foreground", which is assertive and cuts in
  // over whatever is being read. A report of something that already happened can
  // wait its turn, so the component pins type="background".
  const saying = (live: string) =>
    [...document.querySelectorAll(`[role="status"][aria-live="${live}"]`)].some((node) =>
      node.textContent?.includes("Project saved"),
    );
  await expect.poll(() => saying("polite")).toBe(true);
  expect(saying("assertive")).toBe(false);
});

/*
 * The auto-dismiss tests drive the clock rather than waiting on it.
 *
 * Waiting was both slow and wrong. Radix pauses every toast timer on window blur
 * (react-toast/dist/index.mjs:121), which is correct behaviour — a toast should
 * still be there when you tab back — but it means a test that waits out a real
 * duration passes or fails on whether the browser happened to hold focus. Under
 * parallel load it does not, the timer is cleared rather than slowed, and the
 * poll then burns the whole test timeout. Confirmed by dispatching one blur
 * event: the toast never cleared and the test sat for 15 seconds.
 *
 * The toast is fired from an effect rather than a button, because a Playwright
 * click needs the real clock to talk to the browser and fake timers would hang it.
 */
function FireOnMount({ message, options }: { message: string; options?: ToastOptions }) {
  const { toast } = useToast();
  useEffect(() => {
    toast(message, options);
  }, [toast, message, options]);
  return null;
}

function AutoHarness({ message, options }: { message: string; options?: ToastOptions }) {
  return (
    <ToastProvider>
      <FireOnMount message={message} {...(options === undefined ? {} : { options })} />
    </ToastProvider>
  );
}

/*
 * Radix renders a visually hidden live region carrying "Notification <message>"
 * one frame after a toast opens, and keeps it for a second (react-toast:483-486).
 * So a bare getByText on a message resolves to two elements for that second: the
 * pill and the announcer.
 *
 * That is one defect with two faces. A synchronous read races the announcer and
 * fails whenever it loses, which is the one-in-six flake. An awaited read does
 * not fail, but it silently retries through the strict-mode violation until the
 * announcer disappears, which is why some of these tests took a second each.
 *
 * The viewport is the unambiguous root, so every message locator is scoped to it.
 * The announcer lives outside it and is queried on purpose in one test below.
 */
type Screen = Awaited<ReturnType<typeof render>>;

function toastSaying(screen: Screen, message: string) {
  return screen.getByRole("list").getByText(message);
}

/* The DOM, not the accessibility tree: Radix's live region carries the same text. */
const pill = () => document.querySelector("ol > li");

it("clears itself once its time is up", async () => {
  vi.useFakeTimers();
  try {
    await render(<AutoHarness message="Project saved" options={{ duration: 2600 }} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(pill()).not.toBe(null);

    // One tick short of the duration it is still up, so this cannot pass on a
    // toast that never opened or on one that closed immediately.
    await vi.advanceTimersByTimeAsync(2599);
    expect(pill()).not.toBe(null);

    await vi.advanceTimersByTimeAsync(2);
    expect(pill()).toBe(null);
  } finally {
    vi.useRealTimers();
  }
});

it("uses the legacy 2600ms when the caller names no duration", async () => {
  vi.useFakeTimers();
  try {
    await render(<AutoHarness message="Project saved" />);
    await vi.advanceTimersByTimeAsync(0);
    // app.js:1154. Nothing else pins the default, so raising it to Infinity by
    // accident would leave every toast in the app on screen for good.
    await vi.advanceTimersByTimeAsync(2599);
    expect(pill()).not.toBe(null);
    await vi.advanceTimersByTimeAsync(2);
    expect(pill()).toBe(null);
  } finally {
    vi.useRealTimers();
  }
});

it("holds the timer while the window is away and finishes it on return", async () => {
  vi.useFakeTimers();
  try {
    await render(<AutoHarness message="Project saved" options={{ duration: 2600 }} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(pill()).not.toBe(null);

    window.dispatchEvent(new Event("blur"));
    // Twice the duration with the window away. A toast that vanishes while the
    // reader is in another tab is a toast they never saw.
    await vi.advanceTimersByTimeAsync(5200);
    expect(pill()).not.toBe(null);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(2601);
    expect(pill()).toBe(null);
  } finally {
    vi.useRealTimers();
  }
});

it("stays up when the caller asks for no timeout", async () => {
  vi.useFakeTimers();
  try {
    await render(<AutoHarness message="Exporting" options={{ duration: Infinity }} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(pill()).not.toBe(null);

    // Ten times the default duration. The old version of this test slept for
    // 300ms of real time, which proved nothing: a paused timer looks exactly the
    // same as no timer, so it would have passed on a toast that was merely stuck.
    await vi.advanceTimersByTimeAsync(26000);
    expect(pill()).not.toBe(null);
  } finally {
    vi.useRealTimers();
  }
});

it("queues a second message instead of deleting the first", async () => {
  function TwoUp() {
    const { toast } = useToast();
    return (
      <Button
        onClick={() => {
          toast("First", { duration: Infinity });
          toast("Second", { duration: Infinity });
        }}
      >
        Publish
      </Button>
    );
  }
  const screen = await render(
    <ToastProvider>
      <TwoUp />
    </ToastProvider>,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  // app.js:1148 removed the previous toast before adding the next, so a burst of
  // two messages showed only the last one.
  await expect.element(toastSaying(screen, "First")).toBeVisible();
  await expect.element(toastSaying(screen, "Second")).toBeVisible();
});

it("lets the caller dismiss a message it opened", async () => {
  function Manual() {
    const { toast, dismiss } = useToast();
    // A ref, because the id is written by an event and read by another one.
    const id = useRef("");
    return (
      <>
        <Button
          onClick={() => {
            id.current = toast("Exporting", { duration: Infinity });
          }}
        >
          Publish
        </Button>
        <Button
          onClick={() => {
            dismiss(id.current);
          }}
        >
          Finish
        </Button>
      </>
    );
  }
  const screen = await render(
    <ToastProvider>
      <Manual />
    </ToastProvider>,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  await expect.element(toastSaying(screen, "Exporting")).toBeVisible();
  await screen.getByRole("button", { name: "Finish" }).click();
  await expect.poll(() => toastSaying(screen, "Exporting").query()).toBe(null);
});

it("paints a failure in the danger colours", async () => {
  const screen = await render(
    <Harness message="Export failed" options={{ tone: "danger", duration: Infinity }} />,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  // Await the element before reading computed style, like every neighbour here.
  const message = toastSaying(screen, "Export failed");
  await expect.element(message).toBeVisible();
  const pill = message.element().parentElement;
  expect(getComputedStyle(pill as Element).color).toBe("rgb(167, 33, 58)");
});

it("sits on the top rung of the stacking scale", async () => {
  const screen = await render(
    <Harness message="Project saved" options={{ duration: Infinity }} />,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  await expect.element(toastSaying(screen, "Project saved")).toBeVisible();
  const viewport = toastSaying(screen, "Project saved").element().closest("ol");
  // A toast reporting a failure has to clear whatever is over the page.
  expect(getComputedStyle(viewport as Element).zIndex).toBe("100");
});

it("gives F8 a visible landing on the toast list", async () => {
  const screen = await render(
    <Harness message="Project saved" options={{ duration: Infinity }} />,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  await expect.element(toastSaying(screen, "Project saved")).toBeVisible();

  // F8 is Radix's hotkey for reaching toasts from anywhere on the page. It is
  // the route a keyboard user takes to an action inside one, and a keypress that
  // moves focus with nothing to show for it reads as a keypress that did nothing.
  await userEvent.keyboard("{F8}");
  // The DOM, not the accessibility tree: Radix's live region carries the same
  // text for a second after the toast opens, so getByText resolves to two nodes.
  const viewport = document.querySelector("ol");
  await expect.poll(() => document.activeElement).toBe(viewport);

  const style = getComputedStyle(viewport as Element);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
});

it("keeps the shared ring and its cyan edge once focus reaches the toast", async () => {
  const screen = await render(
    <Harness message="Project saved" options={{ duration: Infinity }} />,
  );
  await screen.getByRole("button", { name: "Publish" }).click();
  await expect.element(toastSaying(screen, "Project saved")).toBeVisible();
  await userEvent.keyboard("{F8}");
  await userEvent.keyboard("{Tab}");

  const pill = document.querySelector("ol > li");
  await expect.poll(() => document.activeElement).toBe(pill);
  const style = getComputedStyle(pill as Element);
  expect(style.outlineStyle).toBe("solid");
  // .toast paints --shadow-pop-soft, which outranks :focus-visible. Both have to
  // survive: the ink ring for the indicator, the cyan edge for the look.
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
  expect(style.boxShadow).toContain("rgb(37, 244, 238) 3px 3px");
});
