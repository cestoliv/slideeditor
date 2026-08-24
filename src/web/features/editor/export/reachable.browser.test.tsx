import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { parseProject } from "@shared/schema/index.js";
import { ToastProvider, Tooltip } from "../../../design/index.js";
import { AppRoutes } from "../../../app/router.js";
import { libraryItem, solidImage } from "./testing.js";

/*
 * Does any of this reach the app?
 *
 * Every other test in this directory mounts a piece of Task 17 directly, so all
 * of them stay green while nothing in the editor imports any of it. That is not
 * hypothetical: the export menu and the thumbnail renderer were both written,
 * tested and left mounted nowhere, and `npm run build:web` passed the whole
 * time, because a module nobody imports is tree-shaken away before it can fail.
 *
 * So this file mounts the app's own route table rather than a route of its own.
 * The path, EditorRoute, Editor, the real api client and the real library cache
 * are all under test, which means deleting the /projects/:id route reddens it
 * too. That is the same defect one rung further out, and it is how the whole
 * editor was found unrouted on this branch.
 *
 * Three things are held still, and each one is a fault this file had before it
 * was:
 *
 *   - fetch, because the real client would otherwise reach a server the web
 *     project does not run;
 *   - EventSource, because Editor subscribes to /api/events by default and
 *     nothing serves it here. A failed EventSource retries on its own timer for
 *     as long as the editor is mounted, and this was the only file in the suite
 *     that opened one. An error arriving off that timer lands on whichever test
 *     happens to be in flight, which is what an order-dependent failure looks
 *     like from the outside;
 *   - the container's size, so the stage measures once against a fixed box
 *     rather than against a viewport it is also changing.
 *
 * design/fonts.css is deliberately not imported. Loading it declares TikTok
 * Sans, and renderSlideCanvas awaits document.fonts.load before it draws, so
 * every thumbnail here would have waited on a 1.2 MB font fetch to draw a
 * slide with no text on it.
 */

const BACKGROUND = solidImage(270, 480, "#3355aa");

function project(): Project {
  return parseProject({
    id: "project-1",
    name: "My Slideshow",
    version: 1,
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ratio: { w: 9, h: 16 },
    slides: [
      {
        id: "slide-1",
        backgroundItemId: "background",
        name: "Slide one",
        width: 270,
        height: 480,
        imageScale: 1,
        imageX: 0,
        imageY: 0,
        overlays: [],
        texts: [],
      },
    ],
  });
}

const ITEMS: LibraryItem[] = [libraryItem("background", BACKGROUND, 270, 480)];

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every request the real client makes on this route, and nothing else. */
function serve(path: string): Response {
  if (path.startsWith("/api/projects/project-1")) return answer({ project: project() });
  if (path.startsWith("/api/library")) {
    return answer({ items: ITEMS, total: ITEMS.length });
  }
  return new Response(JSON.stringify({ error: `No stub for ${path}` }), { status: 404 });
}

/** An EventSource that connects to nothing and retries nothing. */
class InertEventSource extends EventTarget {
  readonly readyState = 1;
  close(): void {
    /* Nothing was ever opened. */
  }
}

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

beforeEach(() => {
  globalThis.fetch = (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString();
    return Promise.resolve(serve(path));
  };
  // The shape Editor uses is addEventListener, removeEventListener, readyState
  // and close, which events.ts names as EventStream for exactly this reason.
  globalThis.EventSource = InertEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

/*
 * A fixed box, so the stage's ResizeObserver measures against something that is
 * not also changing underneath it. Mounting the editor into an unsized
 * container let the measurement and the layout chase each other, and Chromium
 * reported it as "ResizeObserver loop completed with undelivered
 * notifications" on every run of this file.
 */
async function mount() {
  return render(
    <div style={{ width: "1200px", height: "820px" }}>
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Tooltip.Provider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </Tooltip.Provider>
      </MemoryRouter>
    </div>,
  );
}

it("puts the export actions in the editor's own header", async () => {
  const screen = await mount();
  // The name field proves the route matched and the editor opened, so a missing
  // button below is a missing button rather than a screen that never arrived.
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Download current slide as PNG" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Download all slides as a ZIP" }))
    .toBeVisible();
});

it("draws the slide rail's thumbnails with the export renderer", async () => {
  /*
   * useSlideThumbnail shows a placeholder until a renderer hands it a blob
   * (useSlideThumbnail.ts:83-99), and Editor passes none of its own unless
   * Task 17's is wired in. A drawn thumbnail is therefore a positive signal
   * that renderSlideBlob ran inside the real editor, reached through the real
   * route, and it is the picture the reader sees rather than a flag about it.
   */
  await mount();
  await expect
    .poll(
      () =>
        document.querySelector<HTMLImageElement>('[data-testid="slide-list"] img')?.src ??
        "",
      { message: "the rail draws a rendered PNG rather than its placeholder" },
    )
    .toMatch(/^blob:/);
});
