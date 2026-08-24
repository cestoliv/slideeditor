import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { Ratio, Slide } from "@shared/schema/index.js";
import { THUMBNAIL_WIDTH, thumbnailHeight } from "@shared/geometry/index.js";
import { fixtureProject } from "./testing.js";
import { THUMBNAIL_DEBOUNCE_MS, useSlideThumbnail } from "./useSlideThumbnail.js";
import type { ThumbnailRenderer } from "./useSlideThumbnail.js";

const RATIO: Ratio = { w: 9, h: 16 };

type Recorder = {
  render: ThumbnailRenderer;
  calls: { slide: Slide; width: number; height: number }[];
  resolve: (() => void)[];
};

/** A renderer that answers a distinct blob per call and records what it was asked. */
function recorder(): Recorder {
  const state: Recorder = {
    render: () => Promise.resolve(new Blob()),
    calls: [],
    resolve: [],
  };
  state.render = (slide, size) => {
    state.calls.push({ slide, width: size.width, height: size.height });
    return Promise.resolve(
      new Blob([`thumb-${String(state.calls.length)}`], { type: "image/png" }),
    );
  };
  return state;
}

function Probe({ slide, render }: { slide: Slide; render: ThumbnailRenderer }) {
  const url = useSlideThumbnail(slide, { ratio: RATIO, render });
  return <span data-testid="url">{url ?? "none"}</span>;
}

function shownUrl(): string {
  return document.querySelector('[data-testid="url"]')?.textContent ?? "";
}

it("draws the first thumbnail at the ratio's thumbnail size", async () => {
  const drawn = recorder();
  const slide = fixtureProject().slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  const screen = await render(<Probe slide={slide} render={drawn.render} />);
  await vi.waitFor(() => {
    expect(shownUrl()).toMatch(/^blob:/);
  });
  expect(drawn.calls).toHaveLength(1);
  expect(drawn.calls[0]?.width).toBe(THUMBNAIL_WIDTH);
  expect(drawn.calls[0]?.height).toBe(thumbnailHeight(RATIO));
  screen.unmount();
});

it("redraws only when the slide's signature changes", async () => {
  vi.useFakeTimers();
  try {
    const drawn = recorder();
    const project = fixtureProject();
    const slide = project.slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const screen = await render(<Probe slide={slide} render={drawn.render} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawn.calls).toHaveLength(1);

    // A re-render that changed nothing about the slide. The old app re-rendered
    // the whole rail on every edit, so a signature that ignored its input would
    // have redrawn every thumbnail on every keystroke.
    screen.rerender(<Probe slide={slide} render={drawn.render} />);
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS * 4);
    expect(drawn.calls).toHaveLength(1);

    slide.texts[0]!.text = "Changed";
    screen.rerender(<Probe slide={slide} render={drawn.render} />);
    // One tick short of the quiet period, nothing has been asked for yet.
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS - 1);
    expect(drawn.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(drawn.calls).toHaveLength(2);
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("does not redraw a slide that only changed identity", async () => {
  vi.useFakeTimers();
  try {
    const drawn = recorder();
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const screen = await render(<Probe slide={slide} render={drawn.render} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawn.calls).toHaveLength(1);

    // A conflict reload hands the editor a new Slide object holding the same
    // values (EditorStore.replaceProject). Redrawing on that is work for
    // nothing, and the old app's signature cache existed to avoid exactly it.
    screen.rerender(<Probe slide={structuredClone(slide)} render={drawn.render} />);
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS * 4);
    expect(drawn.calls).toHaveLength(1);
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("redraws when the slideshow's ratio changes under the same slide", async () => {
  vi.useFakeTimers();
  try {
    const drawn = recorder();
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    function Ratio({ ratio }: { ratio: Ratio }) {
      const url = useSlideThumbnail(slide!, { ratio, render: drawn.render });
      return <span data-testid="url">{url ?? "none"}</span>;
    }

    const screen = await render(<Ratio ratio={RATIO} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawn.calls).toHaveLength(1);
    expect(drawn.calls[0]?.height).toBe(thumbnailHeight(RATIO));

    /*
     * app.js:1591 puts the ratio in the cache key, and nothing else here would
     * notice: applyProjectRatio leaves a slide's own fields alone, so a
     * signature built from the slide alone reads identically at 9:16 and 1:1
     * and every thumbnail in the rail keeps the old shape.
     */
    const square: Ratio = { w: 1, h: 1 };
    screen.rerender(<Ratio ratio={square} />);
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS * 2);
    expect(drawn.calls).toHaveLength(2);
    expect(drawn.calls[1]?.height).toBe(thumbnailHeight(square));
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("coalesces a burst of edits into one redraw", async () => {
  vi.useFakeTimers();
  try {
    const drawn = recorder();
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const screen = await render(<Probe slide={slide} render={drawn.render} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawn.calls).toHaveLength(1);

    for (let step = 0; step < 6; step += 1) {
      slide.texts[0]!.text = `Typing ${String(step)}`;
      screen.rerender(<Probe slide={slide} render={drawn.render} />);
      await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS / 2);
    }
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS * 2);
    // Six keystrokes inside the quiet period are one render, not six.
    expect(drawn.calls).toHaveLength(2);
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("revokes the previous object URL", async () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  try {
    const drawn = recorder();
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const screen = await render(<Probe slide={slide} render={drawn.render} />);
    await vi.waitFor(() => {
      expect(shownUrl()).toMatch(/^blob:/);
    });
    const first = shownUrl();
    expect(revoke).not.toHaveBeenCalled();

    slide.imageScale = 1.5;
    screen.rerender(<Probe slide={slide} render={drawn.render} />);
    await vi.waitFor(() => {
      expect(shownUrl()).not.toBe(first);
    });
    expect(revoke).toHaveBeenCalledWith(first);

    const second = shownUrl();
    screen.unmount();
    // The current app never revokes on teardown, so a session's worth of
    // thumbnails leaks. Closing the editor has to hand them all back.
    expect(revoke).toHaveBeenCalledWith(second);
  } finally {
    revoke.mockRestore();
  }
});

it("leaks nothing when it is unmounted mid-draw", async () => {
  vi.useFakeTimers();
  const created = vi.spyOn(URL, "createObjectURL");
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  try {
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const pending: ((blob: Blob) => void)[] = [];
    const slow: ThumbnailRenderer = () =>
      new Promise<Blob>((resolve) => {
        pending.push(resolve);
      });

    const screen = await render(<Probe slide={slide} render={slow} />);
    await vi.advanceTimersByTimeAsync(0);
    // The very first draw, still in flight. This is the path that returned no
    // cleanup, so unmounting could not cancel it and the URL it minted had no
    // owner left to hand it back.
    expect(pending).toHaveLength(1);
    screen.unmount();

    pending[0]?.(new Blob(["late"], { type: "image/png" }));
    // Microtasks only, so this settles the late render without any real wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(created.mock.calls.length - revoked.mock.calls.length).toBe(0);
  } finally {
    created.mockRestore();
    revoked.mockRestore();
    vi.useRealTimers();
  }
});

it("drops a render that finished after a newer one started", async () => {
  vi.useFakeTimers();
  try {
    const slide = fixtureProject().slides[0];
    if (slide === undefined) throw new Error("The fixture lost its slide.");
    const pending: ((blob: Blob) => void)[] = [];
    const render_: ThumbnailRenderer = () =>
      new Promise<Blob>((resolve) => {
        pending.push(resolve);
      });

    const screen = await render(<Probe slide={slide} render={render_} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);

    slide.imageScale = 2;
    screen.rerender(<Probe slide={slide} render={render_} />);
    await vi.advanceTimersByTimeAsync(THUMBNAIL_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);

    /*
     * Counted at the mint rather than read off the DOM. React's scheduler runs
     * on a MessageChannel, which fake timers do not drive, so a rendered value
     * is not reliably there yet; whether a URL was created at all is.
     */
    const created = vi.spyOn(URL, "createObjectURL");
    try {
      // The second render lands first, then the stale first one answers.
      pending[1]?.(new Blob(["fresh"], { type: "image/png" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveBeenCalledTimes(1);

      pending[0]?.(new Blob(["stale"], { type: "image/png" }));
      await vi.advanceTimersByTimeAsync(0);
      // Overtaken, so it is dropped rather than minted and painted over a
      // newer picture (app.js:1608-1612 bumps a version for this).
      expect(created).toHaveBeenCalledTimes(1);
    } finally {
      created.mockRestore();
    }
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("shows nothing at all when no renderer is wired up", async () => {
  const slide = fixtureProject().slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  function Bare() {
    const url = useSlideThumbnail(slide!, { ratio: RATIO });
    return <span data-testid="url">{url ?? "none"}</span>;
  }
  const screen = await render(<Bare />);
  expect(shownUrl()).toBe("none");
  screen.unmount();
});
