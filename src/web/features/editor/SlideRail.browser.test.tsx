import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
// The rail is laid out from the token layer, so the tests load it the way the app does.
import "../../design/tokens.css";
import "../../design/reset.css";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../design/index.js";
import { OUTPUT_WIDTH, getImageLayout, outputHeight } from "@shared/geometry/index.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { useLibrary } from "../../app/useLibrary.js";
import { EditorStore } from "./store.js";
import { Stage } from "./Stage.js";
import { fixtureProject } from "./testing.js";
import { SlideRail } from "./SlideRail.js";
import type { ThumbnailRenderer } from "./useSlideThumbnail.js";

/** The fixture's own ratio, which the rail publishes and the clamp measures against. */
const RATIO = { w: 9, h: 16 };

function storeFor(project: Project): EditorStore {
  return new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
}

const drawEverything: ThumbnailRenderer = () =>
  Promise.resolve(new Blob(["png"], { type: "image/png" }));

function replacement(id: string): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width: 800,
    height: 600,
    createdAt: 2,
    updatedAt: 2,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

/* A one pixel PNG, so an <img> in the stage resolves rather than logging a 404. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function existing(id: string): LibraryItem {
  return { ...replacement(id), url: `${PIXEL}#${id}`, width: 1080, height: 1920 };
}

/**
 * The rail beside the stage, over one library, which is how the editor mounts
 * them. Testing the rail on its own hid a background change that left the slide
 * pointing at an item no renderer could find.
 */
function Editor({
  store,
  cache,
  uploadBackground,
}: {
  store: EditorStore;
  cache: LibraryCache;
  uploadBackground: (file: File) => Promise<LibraryItem>;
}) {
  const { items } = useLibrary(cache);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 400px", height: "320px" }}>
      <SlideRail
        store={store}
        render={drawEverything}
        library={cache}
        uploadBackground={uploadBackground}
        onAddSlide={() => undefined}
      />
      <Stage store={store} library={items} />
    </div>
  );
}

function stageImageSource(): string | null {
  return (
    document.querySelector<HTMLImageElement>('[data-testid="stage"] img')?.src ?? null
  );
}

function slideIds(store: EditorStore): string[] {
  return store.getSnapshot().project.slides.map((slide) => slide.id);
}

/** A library of its own per rail, so the picker inside it reads no live server. */
function emptyLibrary(): LibraryCache {
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
  });
}

function railFor(store: EditorStore, extra: Record<string, unknown> = {}) {
  return (
    <ToastProvider>
      <div style={{ width: "240px", height: "320px", display: "grid" }}>
        <SlideRail
          store={store}
          render={drawEverything}
          library={emptyLibrary()}
          onAddSlide={() => undefined}
          {...extra}
        />
      </div>
    </ToastProvider>
  );
}

/**
 * Opens one slide's background picker from its menu, the way a person does.
 * The dialog is awaited rather than assumed: its file input does not exist
 * until it is up, and a querySelector racing the render would find nothing.
 */
async function openBackgroundPicker(slideNumber: number): Promise<HTMLInputElement> {
  await userEvent.click(
    page.getByRole("button", { name: `Actions for slide ${String(slideNumber)}` }),
  );
  await userEvent.click(page.getByRole("menuitem", { name: "Change" }));
  await expect
    .element(page.getByRole("dialog", { name: "Change background" }))
    .toBeVisible();
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[type="file"]',
  );
  if (input === null) throw new Error("The picker has no file input.");
  return input;
}

/** A drag from one thumbnail onto another, carried by one DataTransfer. */
function dragOnto(source: Element, target: Element, edge: "top" | "bottom"): void {
  const transfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }),
  );
  const rect = target.getBoundingClientRect();
  const clientY = edge === "top" ? rect.top + 2 : rect.bottom - 2;
  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY,
    }),
  );
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY,
    }),
  );
  source.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
}

function thumbs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-slide-id]")];
}

/** The store publishes at once and React repaints later, so the DOM lags a reorder. */
async function railShows(order: string[]): Promise<void> {
  await vi.waitFor(() => {
    expect(thumbs().map((thumb) => thumb.dataset["slideId"])).toEqual(order);
  });
}

it("shows one thumbnail per slide in order", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));

  const buttons = screen.getByRole("button", { name: /^Open slide/ }).elements();
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Open slide 1",
    "Open slide 2",
    "Open slide 3",
  ]);
  // The numbers are the rail's only ordering cue, so they follow the document.
  expect(thumbs().map((thumb) => thumb.dataset["slideId"])).toEqual([
    "slide-1",
    "slide-2",
    "slide-3",
  ]);
  await vi.waitFor(() => {
    expect(document.querySelectorAll("[data-slide-id] img")).toHaveLength(3);
  });
  screen.unmount();
});

it("switches the active slide on click", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));
  expect(store.getSnapshot().activeSlideId).toBe("slide-1");

  await userEvent.click(screen.getByRole("button", { name: "Open slide 3" }));
  expect(store.getSnapshot().activeSlideId).toBe("slide-3");
  await expect
    .element(screen.getByRole("button", { name: "Open slide 3" }))
    .toHaveAttribute("aria-current", "true");
  screen.unmount();
});

it("reorders slides by dragging one onto another", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));

  const [first, , third] = thumbs();
  if (first === undefined || third === undefined)
    throw new Error("The rail lost a slide.");
  // The first slide, dropped below the third.
  dragOnto(first, third, "bottom");
  expect(slideIds(store)).toEqual(["slide-2", "slide-3", "slide-1"]);
  await railShows(["slide-2", "slide-3", "slide-1"]);

  const moved = thumbs();
  const last = moved[2];
  const head = moved[0];
  if (last === undefined || head === undefined) throw new Error("The rail lost a slide.");
  expect(last.dataset["slideId"]).toBe("slide-1");
  // And back above the one now at the top.
  dragOnto(last, head, "top");
  expect(slideIds(store)).toEqual(["slide-1", "slide-2", "slide-3"]);
  await railShows(["slide-1", "slide-2", "slide-3"]);

  // An undo puts the whole reorder back, so it was one history entry.
  store.undo();
  expect(slideIds(store)).toEqual(["slide-2", "slide-3", "slide-1"]);
  screen.unmount();
});

it("reorders from the drag payload when no drag started in this rail", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));
  const rows = thumbs();
  const target = rows[2];
  if (target === undefined) throw new Error("The rail lost a slide.");

  /*
   * The MIME type spelled out rather than imported, because it is the contract
   * and not an implementation detail: app.js:3105 named it, a slide copied in
   * another window arrives under it, and renaming it silently strands every
   * such drop. No dragstart here, so the in-memory source id is null and the
   * payload is the only thing that can identify the slide.
   */
  const transfer = new DataTransfer();
  transfer.setData("application/x-slide-studio-slide", "slide-1");
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY: rect.bottom - 2,
    }),
  );
  expect(slideIds(store)).toEqual(["slide-2", "slide-3", "slide-1"]);
  screen.unmount();
});

it("ignores a drop carrying no slide of ours", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));
  const rows = thumbs();
  const target = rows[2];
  if (target === undefined) throw new Error("The rail lost a slide.");

  const transfer = new DataTransfer();
  // A file drag, or a slide from some other app. Neither is ours to reorder.
  transfer.setData("text/plain", "slide-1");
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY: rect.bottom - 2,
    }),
  );
  expect(slideIds(store)).toEqual(["slide-1", "slide-2", "slide-3"]);
  expect(store.canUndo()).toBe(false);
  screen.unmount();
});

it("ignores a slide dropped on itself", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));
  const [first] = thumbs();
  if (first === undefined) throw new Error("The rail lost a slide.");
  dragOnto(first, first, "bottom");
  expect(slideIds(store)).toEqual(["slide-1", "slide-2", "slide-3"]);
  expect(store.canUndo()).toBe(false);
  screen.unmount();
});

it("keeps its scroll position when the active slide changes", async () => {
  const store = storeFor(fixtureProject({ slides: 14 }));
  const screen = await render(railFor(store));
  const list = document.querySelector<HTMLElement>('[data-testid="slide-list"]');
  if (list === null) throw new Error("The slide list did not render.");
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

  list.scrollTop = 90;
  expect(list.scrollTop).toBe(90);
  store.setActiveSlide("slide-9");
  await vi.waitFor(() => {
    expect(store.getSnapshot().activeSlideId).toBe("slide-9");
  });
  // The old app re-rendered the rail and had to save and restore this by hand
  // (app.js:1521-1523). React keeps the container, so nothing needs restoring.
  expect(list.scrollTop).toBe(90);
  screen.unmount();
});

it("removes a slide from its menu and asks first", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  const screen = await render(railFor(store));

  await userEvent.click(screen.getByRole("button", { name: "Actions for slide 2" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  // Still three: the menu asks before it cuts.
  expect(slideIds(store)).toEqual(["slide-1", "slide-2", "slide-3"]);

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(slideIds(store)).toEqual(["slide-1", "slide-2", "slide-3"]);

  await userEvent.click(screen.getByRole("button", { name: "Actions for slide 2" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove slide" }));
  expect(slideIds(store)).toEqual(["slide-1", "slide-3"]);
  screen.unmount();
});

it("moves to the next slide when the active one is removed", async () => {
  const store = storeFor(fixtureProject({ slides: 3 }));
  store.setActiveSlide("slide-2");
  const screen = await render(railFor(store));

  await userEvent.click(screen.getByRole("button", { name: "Actions for slide 2" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove slide" }));
  // app.js:3054 takes the slide that moved into the gap, not the first one.
  expect(store.getSnapshot().activeSlideId).toBe("slide-3");
  screen.unmount();
});

it("replaces a slide's background from its menu", async () => {
  const store = storeFor(fixtureProject({ slides: 2 }));
  const uploaded: File[] = [];
  const upload = (file: File) => {
    uploaded.push(file);
    return Promise.resolve(replacement("item-new"));
  };
  const screen = await render(railFor(store, { uploadBackground: upload }));

  const input = await openBackgroundPicker(1);
  await userEvent.upload(input, new File(["png"], "beach.png", { type: "image/png" }));

  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.backgroundItemId).toBe("item-new");
  });
  expect(uploaded.map((file) => file.name)).toEqual(["beach.png"]);
  const slide = store.getSnapshot().project.slides[0];
  // The new asset's own pixels, so the photo is not stretched to the old ones.
  expect(slide?.width).toBe(800);
  expect(slide?.height).toBe(600);
  // Only the slide the menu was opened on.
  expect(store.getSnapshot().project.slides[1]?.backgroundItemId).toBe("item-2");
  screen.unmount();
});

it("keeps the stage painted after a background is replaced", async () => {
  const store = storeFor(fixtureProject({ slides: 1 }));
  const cache = new LibraryCache({
    listLibrary: () => Promise.resolve({ items: [existing("item-1")], total: 1 }),
  });
  const upload = () => Promise.resolve(replacement("item-new"));
  const screen = await render(
    <ToastProvider>
      <Editor store={store} cache={cache} uploadBackground={upload} />
    </ToastProvider>,
  );
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("#item-1");
  });

  const input = await openBackgroundPicker(1);
  await userEvent.upload(input, new File(["png"], "beach.png", { type: "image/png" }));

  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.backgroundItemId).toBe("item-new");
  });
  // app.js:3026 remembers the uploaded item before the document points at it.
  // Without that the slide names an item the cache has never heard of, every
  // render resolves it to null, and the stage goes blank.
  expect(cache.get("item-new")?.url).toBe("/media/item-new.png");
  await vi.waitFor(() => {
    expect(stageImageSource()).toContain("/media/item-new.png");
  });
  screen.unmount();
});

it("pulls the pan back inside a background of a different shape", async () => {
  const store = storeFor(fixtureProject({ slides: 1 }));
  store.mutate((document) => {
    const slide = document.slides[0];
    if (slide === undefined) return;
    // A wide photo, panned a long way sideways because a wide photo at cover
    // has a long way to go. All of this is legal for the shape it has now.
    slide.width = 3000;
    slide.height = 800;
    slide.imageScale = 1.2;
    slide.imageX = 0.8;
    slide.imageY = 0.08;
  });
  // Replaced with a tall one, which at the same zoom has almost no sideways
  // overhang left and a great deal above and below.
  const tall = { ...replacement("item-tall"), width: 800, height: 3000 };
  const screen = await render(
    railFor(store, { uploadBackground: () => Promise.resolve(tall) }),
  );

  const input = await openBackgroundPicker(1);
  await userEvent.upload(input, new File(["png"], "tall.png", { type: "image/png" }));

  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.backgroundItemId).toBe("item-tall");
  });
  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture lost its slide.");
  const canvasHeight = outputHeight(RATIO);
  const layout = getImageLayout(slide, OUTPUT_WIDTH, canvasHeight);

  /*
   * app.js:3033. The old pan is further than the new photo can cover, and left
   * alone it would show a strip of empty canvas down one edge of the slide.
   */
  expect(layout.maxOffsetX).toBeGreaterThan(0);
  expect(layout.maxOffsetX).toBeLessThan(0.8);
  expect(slide.imageX).toBeCloseTo(layout.maxOffsetX, 6);
  // Pulled back to the new edge rather than reset: the pan is the reader's.
  expect(slide.imageX).toBeGreaterThan(0);
  // And the axis that still has room is left exactly where it was.
  expect(layout.maxOffsetY).toBeGreaterThan(0.08);
  expect(slide.imageY).toBeCloseTo(0.08, 6);
  // Which is the point of all of it: no gap on any edge.
  expect(layout.left).toBeLessThanOrEqual(0.001);
  expect(layout.left + layout.width).toBeGreaterThanOrEqual(OUTPUT_WIDTH - 0.001);
  expect(layout.top).toBeLessThanOrEqual(0.001);
  expect(layout.top + layout.height).toBeGreaterThanOrEqual(canvasHeight - 0.001);
  screen.unmount();
});

it("leaves the slide alone when the upload fails", async () => {
  const store = storeFor(fixtureProject({ slides: 1 }));
  const upload = () => Promise.reject(new Error("nope"));
  const screen = await render(railFor(store, { uploadBackground: upload }));

  const input = await openBackgroundPicker(1);
  await userEvent.upload(input, new File(["png"], "broken.png", { type: "image/png" }));

  // The picker is what the reader is looking at, so it is what says so, and it
  // stays up rather than closing over a slide it did not change.
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That image couldn’t be uploaded.");
  expect(store.getSnapshot().project.slides[0]?.backgroundItemId).toBe("item-1");
  screen.unmount();
});

/**
 * Runs a test at a viewport width, then puts the old one back. Vitest resizes
 * the iframe the whole file renders into, so leaving it narrow would reshape
 * every test that follows.
 */
async function atWidth(width: number, run: () => Promise<void>): Promise<void> {
  const was = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, was.height);
  try {
    await run();
  } finally {
    await page.viewport(was.width, was.height);
  }
}

/** The rail at the width the editor's own grid gives it below 780px. */
function narrowRail(store: EditorStore) {
  return (
    <ToastProvider>
      <div style={{ width: "68px", height: "460px", display: "grid" }}>
        <SlideRail store={store} render={drawEverything} onAddSlide={() => undefined} />
      </div>
    </ToastProvider>
  );
}

it("drops to one column of pictures on a narrow screen", async () => {
  await atWidth(760, async () => {
    const store = storeFor(fixtureProject({ slides: 3 }));
    const screen = await render(narrowRail(store));
    await expect
      .element(screen.getByRole("button", { name: "Open slide 1" }))
      .toBeVisible();

    // styles.css:3272-3278 collapsed all of these. At 68px there is room for
    // the picture and nothing else.
    const heading = document.querySelector("h2");
    if (heading === null) throw new Error("The rail lost its heading.");
    expect(getComputedStyle(heading).display).toBe("none");
    const number = document.querySelector<HTMLElement>("[data-slide-id] span");
    if (number === null) throw new Error("The rail lost its numbers.");
    expect(getComputedStyle(number).display).toBe("none");

    // styles.css:3298. One column, so the picture takes the whole row rather
    // than the sliver left beside a number.
    const open = screen.getByRole("button", { name: "Open slide 1" }).element();
    expect(getComputedStyle(open).gridTemplateColumns.split(" ")).toHaveLength(1);

    // Every slide is still named, which is what carries the number now.
    expect(screen.getByRole("button", { name: /^Open slide/ }).elements()).toHaveLength(
      3,
    );
    screen.unmount();
  });
});

it("keeps the row itself clickable when the menu trigger is beside it", async () => {
  await atWidth(760, async () => {
    const store = storeFor(fixtureProject({ slides: 3 }));
    const screen = await render(narrowRail(store));
    const open = screen.getByRole("button", { name: "Open slide 1" });
    await expect.element(open).toBeVisible();

    /*
     * The regression this guards: at 68px the trigger and the open button are
     * within a few pixels of each other, and a trigger that covers the middle
     * of the row turns every tap into a menu instead of a slide. app.js never
     * had to answer this, because its menu was a right-click and it drew no
     * trigger at all.
     */
    const box = open.element().getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    expect(open.element().contains(hit)).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Open slide 2" }));
    expect(store.getSnapshot().activeSlideId).toBe("slide-2");
    screen.unmount();
  });
});
