import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "./useDebouncedValue.js";

/*
 * The clock is driven, never waited on: a test that sleeps 200ms proves nothing,
 * because a value that was never debounced looks exactly the same afterwards.
 */

function Probe({ value }: { value: string }) {
  const debounced = useDebouncedValue(value, SEARCH_DEBOUNCE_MS);
  return <p data-testid="out">{debounced}</p>;
}

function shown(): string {
  return document.querySelector('[data-testid="out"]')?.textContent ?? "";
}

/*
 * React commits a state change from a timer on its scheduler's own macrotask,
 * which rides a MessageChannel rather than a timer, so a faked clock never
 * reaches it. Posting a message queues behind React's and resolves once the
 * render is on screen. Ordering, not waiting: no duration appears here.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

it("holds the legacy 200ms", () => {
  // app.js:1403. Nothing else pins it, and a debounce raised to a second turns
  // a search that feels instant into one that feels broken.
  expect(SEARCH_DEBOUNCE_MS).toBe(200);
});

it("shows the first value at once", async () => {
  vi.useFakeTimers();
  try {
    await render(<Probe value="sun" />);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(shown()).toBe("sun");
  } finally {
    vi.useRealTimers();
  }
});

it("waits the full delay before passing a change on", async () => {
  vi.useFakeTimers();
  try {
    const screen = await render(<Probe value="" />);
    await vi.advanceTimersByTimeAsync(0);

    screen.rerender(<Probe value="sunset" />);
    // One tick short of the delay. This cannot pass on a hook that returns its
    // input untouched, because that one would already read "sunset" here.
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    await flush();
    expect(shown()).toBe("");

    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(shown()).toBe("sunset");
  } finally {
    vi.useRealTimers();
  }
});

it("restarts the wait on every keystroke rather than firing part way", async () => {
  vi.useFakeTimers();
  try {
    const screen = await render(<Probe value="" />);
    await vi.advanceTimersByTimeAsync(0);

    // Three keystrokes 150ms apart. A throttle would have published "s" by now.
    screen.rerender(<Probe value="s" />);
    await vi.advanceTimersByTimeAsync(150);
    screen.rerender(<Probe value="su" />);
    await vi.advanceTimersByTimeAsync(150);
    screen.rerender(<Probe value="sun" />);
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    expect(shown()).toBe("");

    await vi.advanceTimersByTimeAsync(60);
    await flush();
    expect(shown()).toBe("sun");
  } finally {
    vi.useRealTimers();
  }
});

it("settles on the last value when typing stops mid word", async () => {
  vi.useFakeTimers();
  try {
    const screen = await render(<Probe value="" />);
    await vi.advanceTimersByTimeAsync(0);
    screen.rerender(<Probe value="sunse" />);
    screen.rerender(<Probe value="sunset" />);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1);
    // Never an intermediate value, which is what a queue of pending timers would
    // leave behind.
    await flush();
    expect(shown()).toBe("sunset");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 4);
    await flush();
    expect(shown()).toBe("sunset");
  } finally {
    vi.useRealTimers();
  }
});
