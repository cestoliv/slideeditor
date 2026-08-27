import { afterAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { page, userEvent } from "vitest/browser";
import "../../design/tokens.css";
import "../../design/reset.css";
import {
  getOverlayMetrics,
  naturalOverlayHeight,
  outputAspect,
} from "@shared/geometry/index.js";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem, Project, Ratio } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../app/useLibrary.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { ToastProvider } from "../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../app/accounts.js";
import { Editor } from "./Editor.js";
import { EditorStore } from "./store.js";
import { fixtureProject } from "./testing.js";
import { RatioMenu } from "./RatioMenu.js";

function storeFor(project: Project): EditorStore {
  return new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
}

/** A landscape asset, so a squashed overlay is visible as a changed shape. */
function asset(id: string): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width: 1600,
    height: 900,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

/*
 * Files share one page, so a viewport left behind here reaches the next one.
 * The size found on arrival is put back on the way out.
 */
const inherited = { width: window.innerWidth, height: window.innerHeight };

afterAll(async () => {
  await page.viewport(inherited.width, inherited.height);
});

const LIBRARY: LibraryIndex = new Map([["item-1", asset("item-1")]]);

function mount(store: EditorStore, onApplied?: (message: string) => void) {
  return render(<RatioMenu store={store} library={LIBRARY} onApplied={onApplied} />);
}

function ratioOf(store: EditorStore): Ratio {
  return store.getSnapshot().project.ratio;
}

/**
 * The shape an overlay actually renders as, in canvas units turned back into a
 * pixel aspect. This is the number the README promises stays put: a photo must
 * not squash when the slide's ratio changes.
 */
function overlayAspect(store: EditorStore): number {
  const project = store.getSnapshot().project;
  const overlay = project.slides[0]?.overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  const metrics = getOverlayMetrics(overlay, asset("item-1"), { ratio: project.ratio });
  return metrics.width / (metrics.height / outputAspect(project.ratio));
}

async function openPresets(): Promise<void> {
  await userEvent.click(
    document.querySelector<HTMLElement>('[aria-label="Change the slide ratio"]') ??
      document.body,
  );
}

it("lists every preset ratio", async () => {
  const store = storeFor(fixtureProject());
  const screen = await mount(store);

  await openPresets();

  /*
   * Anchored, because the row's accessible name carries its note as well and
   * "1:1" is a substring of "1.91:1".
   */
  for (const label of [/^9:16/, /^3:4/, /^4:5/, /^1:1/, /^1\.91:1/]) {
    await expect
      .element(screen.getByRole("menuitemradio", { name: label }))
      .toBeVisible();
  }
  // The one the slideshow is already on reads as chosen (app.js:816).
  await expect
    .element(screen.getByRole("menuitemradio", { name: /^9:16/ }))
    .toHaveAttribute("aria-checked", "true");
  screen.unmount();
});

it("applies a preset ratio", async () => {
  const store = storeFor(fixtureProject());
  const applied: string[] = [];
  const screen = await mount(store, (message) => applied.push(message));

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^4:5/ }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 4, h: 5 });
  });
  // app.js:895 says the new export size, which is the only place it is shown.
  expect(applied.at(-1)).toBe("Slides are now 4:5 · 1080 × 1350");
  screen.unmount();
});

it("accepts a custom ratio between 0.4 and 2.5", async () => {
  const store = storeFor(fixtureProject());
  const screen = await mount(store);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitem", { name: "Custom ratio…" }));
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Width" }), "5");
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Height" }), "4");
  await expect.element(screen.getByText("Exports at 1080 × 864.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 5, h: 4 });
  });
  screen.unmount();
});

it("rejects a ratio outside the band", async () => {
  const store = storeFor(fixtureProject());
  const screen = await mount(store);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitem", { name: "Custom ratio…" }));
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Width" }), "9");
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Height" }), "1");

  await expect
    .element(screen.getByText("Keep the ratio between 0.4:1 and 2.5:1."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  expect(ratioOf(store)).toEqual({ w: 9, h: 16 });
  screen.unmount();
});

/* app.js:838-842. Two numbers, and neither of them zero. */
it("refuses two numbers that are not a ratio", async () => {
  const store = storeFor(fixtureProject());
  const screen = await mount(store);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitem", { name: "Custom ratio…" }));
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Height" }), "0");

  await expect.element(screen.getByText("Enter two positive numbers.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  screen.unmount();
});

/*
 * app.js:853. TikTok's own 9:16 sits below Instagram's band, so a ratio outside
 * it is flagged rather than refused.
 */
it("flags a ratio Instagram will not take without blocking it", async () => {
  const store = storeFor(fixtureProject());
  const screen = await mount(store);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitem", { name: "Custom ratio…" }));
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Width" }), "1");
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Height" }), "2");

  await expect
    .element(screen.getByText("Instagram accepts 3:4 to 1.91:1. TikTok takes this one."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  screen.unmount();
});

it("keeps every layer's relative position when the ratio changes", async () => {
  const store = storeFor(fixtureProject({ texts: 2, overlays: 1 }));
  const before = structuredClone(store.getSnapshot().project.slides[0]);
  const screen = await mount(store);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^1:1/ }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 1, h: 1 });
  });
  const after = store.getSnapshot().project.slides[0];
  expect(after?.texts.map((text) => [text.x, text.y, text.width, text.height])).toEqual(
    before?.texts.map((text) => [text.x, text.y, text.width, text.height]),
  );
  expect(after?.overlays.map((overlay) => [overlay.x, overlay.y, overlay.width])).toEqual(
    before?.overlays.map((overlay) => [overlay.x, overlay.y, overlay.width]),
  );
  screen.unmount();
});

/*
 * app.js:889 re-clamps every slide's pan on a ratio change, and it is there for
 * a reason a geometry-only test cannot see: the overhang a zoomed background
 * may be panned into depends on the canvas height, so a pan that is legal at
 * 3:4 leaves a gap at 9:16.
 *
 * The fixture pans and zooms first, because at imageScale 1 with no pan the
 * clamp is a no-op by construction and deleting it changes nothing.
 *
 * At 3:4 the canvas is 1080 x 1440 and a 2x background may be panned 0.833 of a
 * canvas height. At 9:16 it is 1080 x 1920 and the same background may be
 * panned only 0.5, so 0.8 has to come back to exactly that.
 */
it("pulls a panned background back inside the new ratio's bounds", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    document.ratio = { w: 3, h: 4 };
    const slide = document.slides[0];
    if (slide !== undefined) {
      slide.imageScale = 2;
      slide.imageY = 0.8;
    }
  });
  const screen = await mount(store);
  expect(store.getSnapshot().project.slides[0]?.imageY).toBe(0.8);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^9:16/ }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 9, h: 16 });
  });
  expect(store.getSnapshot().project.slides[0]?.imageY).toBeCloseTo(0.5, 6);
  // The zoom itself is untouched: this clamps the pan, it does not reset the photo.
  expect(store.getSnapshot().project.slides[0]?.imageScale).toBe(2);
  screen.unmount();
});

/*
 * The promise in the README. An overlay's width is a share of the canvas width
 * and its height a share of the canvas height, so a stored height is stale the
 * moment the aspect changes and the photo would squash. app.js:885-887
 * recomputes it from the asset and the crop.
 */
it("keeps an overlay's aspect ratio when the slide's ratio changes", async () => {
  const store = storeFor(fixtureProject({ texts: 1, overlays: 1 }));
  // normalizeProject fills a missing height from the asset at load
  // (app.js:119-123), so every overlay in the running app starts undistorted.
  // The fixture stores a flat 0.34, which is not that, so it is set first.
  store.mutate((document) => {
    const overlay = document.slides[0]?.overlays[0];
    if (overlay !== undefined) {
      overlay.height = naturalOverlayHeight(overlay.width, asset("item-1"), {
        w: 9,
        h: 16,
      });
    }
  });
  const screen = await mount(store);
  const before = overlayAspect(store);
  expect(before).toBeCloseTo(1600 / 900, 3);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^1\.91:1/ }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 1.91, h: 1 });
  });
  expect(overlayAspect(store)).toBeCloseTo(before, 3);
  screen.unmount();
});

/*
 * The other half of the same rule, pinned because it is a real behaviour rather
 * than an accident: app.js:885-887 recomputes every overlay height from the
 * asset, so a height the author dragged away from the natural shape is reset by
 * a ratio change. Nothing in the running app preserves it, and this records that.
 */
it("resets an overlay resized away from its natural shape", async () => {
  const store = storeFor(fixtureProject({ texts: 1, overlays: 1 }));
  const screen = await mount(store);
  expect(store.getSnapshot().project.slides[0]?.overlays[0]?.height).toBe(0.34);

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^1:1/ }));

  await vi.waitFor(() => {
    expect(ratioOf(store)).toEqual({ w: 1, h: 1 });
  });
  expect(overlayAspect(store)).toBeCloseTo(1600 / 900, 3);
  screen.unmount();
});

/* app.js:875. Choosing the ratio the slideshow is already on records nothing. */
it("does nothing when the chosen ratio is the one already set", async () => {
  const store = storeFor(fixtureProject());
  const applied: string[] = [];
  const screen = await mount(store, (message) => applied.push(message));

  await openPresets();
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^9:16/ }));

  await vi.waitFor(() => {
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  });
  expect(applied).toHaveLength(0);
  expect(store.canUndo()).toBe(false);
  screen.unmount();
});

/*
 * The panel where it actually lives, rather than on its own.
 *
 * Radix portals the menu to the body, but in the React tree it stays a
 * descendant of Stage's surface, and React propagates events along that tree.
 * Stage's marquee therefore sees a press on a menu row, captures the pointer
 * onto the surface, and the row never receives its own pointerup: every preset
 * became unpickable the moment this menu was mounted inside the stage. Mounting
 * the whole editor is the only way that shows up.
 */
it("picks a ratio from inside the editor", async () => {
  const project = fixtureProject();
  const client = {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent: Project) =>
      Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 }),
    setStatus: () => Promise.resolve({}),
  };
  // The editor lays out as four columns, so it needs a desktop to be reachable.
  await page.viewport(1280, 900);
  const screen = await render(
    <MemoryRouter initialEntries={["/projects/project-1"]}>
      <ToastProvider>
        <AccountsProvider
          store={
            new AccountsStore({
              listAccounts: () => Promise.resolve({ accounts: [] }),
              listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
              createAccount: () => Promise.reject(new Error("not used")),
              updateAccount: () => Promise.reject(new Error("not used")),
              deleteAccount: () => Promise.reject(new Error("not used")),
              addGoogleFont: () => Promise.reject(new Error("not used")),
              deleteFont: () => Promise.reject(new Error("not used")),
            })
          }
        >
          <Routes>
            <Route
              path="/projects/:id"
              element={
                <Editor
                  projectId="project-1"
                  client={client}
                  library={
                    new LibraryCache({
                      listLibrary: () => Promise.resolve({ items: [], total: 0 }),
                    })
                  }
                  subscribe={() => () => undefined}
                />
              }
            />
          </Routes>
        </AccountsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Change the slide ratio" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^4:5/ }));

  await expect
    .element(screen.getByRole("button", { name: "Change the slide ratio" }))
    .toHaveTextContent("1080 × 1350 · 4:5");
  screen.unmount();
});
