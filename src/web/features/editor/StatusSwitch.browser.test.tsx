import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../design/tokens.css";
import "../../design/reset.css";
import type { Project, SlideshowStatus } from "@shared/schema/index.js";
import { EditorStore } from "./store.js";
import { SAVE_DEBOUNCE_MS } from "./persistence.js";
import { fixtureProject } from "./testing.js";
import { StatusSwitch } from "./StatusSwitch.js";

type Recorder = {
  store: EditorStore;
  /** Every status the server was told about, in order. */
  statuses: SlideshowStatus[];
  /** Every document write, so a test can see the status ride none of them. */
  saved: Project[];
  errors: unknown[];
};

function recorder(options: { refuse?: boolean } = {}): Recorder {
  const statuses: SlideshowStatus[] = [];
  const saved: Project[] = [];
  const errors: unknown[] = [];
  const store = new EditorStore(fixtureProject(), {
    save: (project) => {
      saved.push(structuredClone(project));
      return Promise.resolve({
        ...structuredClone(project),
        version: project.version + 1,
      });
    },
    setStatus: (_id, status) => {
      statuses.push(status);
      return options.refuse === true
        ? Promise.reject(new Error("nope"))
        : Promise.resolve({});
    },
    onError: (error) => errors.push(error),
  });
  return { store, statuses, saved, errors };
}

it("moves a slideshow between draft, ready, and published", async () => {
  const world = recorder();
  const screen = await render(<StatusSwitch store={world.store} />);

  await expect
    .element(screen.getByRole("button", { name: "Draft" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "Ready" }));
  await vi.waitFor(() => {
    expect(world.store.getSnapshot().project.status).toBe("ready");
  });
  await expect
    .element(screen.getByRole("button", { name: "Ready" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Draft" }))
    .toHaveAttribute("aria-pressed", "false");

  await userEvent.click(screen.getByRole("button", { name: "Published" }));
  await vi.waitFor(() => {
    expect(world.store.getSnapshot().project.status).toBe("published");
  });
  expect(world.statuses).toEqual(["ready", "published"]);
  screen.unmount();
});

/*
 * The reason the status endpoint exists. It skips the version guard and leaves
 * the version alone, so marking a slideshow ready can never make an open
 * editor's next save conflict (src/server/services/projects.ts).
 *
 * The version is read after the write has landed on the server, so a version
 * bump had every chance to arrive.
 */
it("does not change the version when the status changes", async () => {
  const world = recorder();
  const before = world.store.getSnapshot().project.version;
  const screen = await render(<StatusSwitch store={world.store} />);

  await userEvent.click(screen.getByRole("button", { name: "Ready" }));
  await vi.waitFor(() => {
    expect(world.statuses).toEqual(["ready"]);
  });

  expect(world.store.getSnapshot().project.version).toBe(before);
  // And it rode no document write, which is the mechanism that keeps it so.
  expect(world.saved).toHaveLength(0);
  screen.unmount();
});

/*
 * A positive signal rather than the absence of one: the edit made after
 * publishing reaches the server, carrying the version the status left alone.
 * That is causally downstream of the slideshow still being editable, and it
 * discriminates, because a document frozen at publish would send nothing.
 */
it("keeps the slideshow editable after publishing", async () => {
  vi.useFakeTimers();
  try {
    const world = recorder();
    const screen = await render(<StatusSwitch store={world.store} />);
    await vi.advanceTimersByTimeAsync(0);

    await userEvent.click(screen.getByRole("button", { name: "Published" }));
    await vi.waitFor(() => {
      expect(world.store.getSnapshot().project.status).toBe("published");
    });

    world.store.rename("After publishing");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);

    expect(world.saved).toHaveLength(1);
    expect(world.saved[0]?.name).toBe("After publishing");
    expect(world.saved[0]?.version).toBe(1);
    expect(world.saved[0]?.status).toBe("published");
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});

/* app.js:947-951. A server that refuses puts the old label back. */
it("puts the old status back when the server refuses", async () => {
  const world = recorder({ refuse: true });
  const screen = await render(<StatusSwitch store={world.store} />);

  await userEvent.click(screen.getByRole("button", { name: "Ready" }));

  await vi.waitFor(() => {
    expect(world.errors).toHaveLength(1);
  });
  expect(world.store.getSnapshot().project.status).toBe("draft");
  await expect
    .element(screen.getByRole("button", { name: "Draft" }))
    .toHaveAttribute("aria-pressed", "true");
  screen.unmount();
});

/* app.js:935. Choosing the status it already has says nothing to the server. */
it("says nothing when the status does not change", async () => {
  const world = recorder();
  const screen = await render(<StatusSwitch store={world.store} />);

  await userEvent.click(screen.getByRole("button", { name: "Draft" }));

  await expect
    .element(screen.getByRole("button", { name: "Draft" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(world.statuses).toEqual([]);
  screen.unmount();
});
