import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { page, userEvent } from "vitest/browser";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import { OUTPUT_WIDTH } from "@shared/geometry/index.js";
import type { Project, Slide } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { Editor } from "../Editor.js";
import type { EditorClient } from "../Editor.js";
import { fixtureProject } from "../testing.js";
import type { ThumbnailRenderer } from "../useSlideThumbnail.js";

/*
 * Files share one page, so a viewport left behind here reaches the next one.
 * The size found on arrival is put back on the way out.
 */
const inherited = { width: window.innerWidth, height: window.innerHeight };

afterAll(async () => {
  await page.viewport(inherited.width, inherited.height);
});

/*
 * The editor lays out as columns, so these tests pin a desktop rather than
 * inheriting whatever the last file left behind.
 */
beforeAll(async () => {
  await page.viewport(1280, 900);
});

/* Everything the mock-ups put on screen, and nothing the document ever holds. */
const CHROME_WORDS = ["PREVIEW ONLY", "yourname", "For You", "Send message"];

type World = {
  client: EditorClient;
  /** Every slide the renderer was handed, cloned at the moment it was handed over. */
  drawn: Slide[];
  saved: Project[];
  render: ThumbnailRenderer;
};

function world(project: Project): World {
  const drawn: Slide[] = [];
  const saved: Project[] = [];
  return {
    drawn,
    saved,
    render: (slide) => {
      drawn.push(structuredClone(slide));
      return Promise.resolve(new Blob(["png"], { type: "image/png" }));
    },
    client: {
      getProject: () => Promise.resolve({ project: structuredClone(project) }),
      save: (sent) => {
        saved.push(structuredClone(sent));
        return Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 });
      },
      setStatus: () => Promise.resolve({}),
    },
  };
}

function emptyLibrary(): LibraryCache {
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
  });
}

function mount(it_: World) {
  return render(
    <MemoryRouter initialEntries={["/projects/project-1"]}>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<p>Somewhere else</p>} />
          <Route
            path="/projects/:id"
            element={
              <Editor
                projectId="project-1"
                client={it_.client}
                library={emptyLibrary()}
                subscribe={() => () => undefined}
                render={it_.render}
              />
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function chromeNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="preview-chrome"]');
}

async function chooseOverlay(name: string | RegExp): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(
    '[aria-label="Choose the UI preview overlay"]',
  );
  if (trigger === null) throw new Error("The canvas has no overlay menu.");
  await userEvent.click(trigger);
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const row = rows.find((item) =>
    typeof name === "string"
      ? item.textContent === name
      : name.test(item.textContent ?? ""),
  );
  if (row === undefined) {
    throw new Error(`No overlay row named ${String(name)} among ${String(rows.length)}.`);
  }
  await userEvent.click(row);
}

it("suggests TikTok chrome for a 9:16 slideshow", async () => {
  const stage = world(fixtureProject());
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();

  await userEvent.click(
    screen.getByRole("button", { name: "Choose the UI preview overlay" }),
  );

  await expect
    .element(screen.getByRole("menuitemradio", { name: /TikTok/ }))
    .toHaveAccessibleName("TikTok, suggested");
  await expect
    .element(screen.getByRole("menuitemradio", { name: /Instagram feed/ }))
    .toHaveAccessibleName("Instagram feed");
  screen.unmount();
});

it("suggests Instagram feed chrome for a 4:5 slideshow", async () => {
  const project = fixtureProject();
  project.ratio = { w: 4, h: 5 };
  const stage = world(project);
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();

  await userEvent.click(
    screen.getByRole("button", { name: "Choose the UI preview overlay" }),
  );

  await expect
    .element(screen.getByRole("menuitemradio", { name: /Instagram feed/ }))
    .toHaveAccessibleName("Instagram feed, suggested");
  await expect
    .element(screen.getByRole("menuitemradio", { name: /TikTok/ }))
    .toHaveAccessibleName("TikTok");
  screen.unmount();
});

it("draws no chrome until one is chosen, then draws it over the stage", async () => {
  const stage = world(fixtureProject());
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();
  expect(chromeNode()).toBeNull();

  await chooseOverlay(/^TikTok/);

  await vi.waitFor(() => {
    expect(chromeNode()?.dataset["chrome"]).toBe("tiktok");
  });
  await expect.element(screen.getByText("PREVIEW ONLY · NOT EXPORTED")).toBeVisible();
  // app.js:1743. Decoration, so it is out of the accessibility tree and takes
  // no pointer events away from the layers under it.
  const node = chromeNode();
  expect(node?.getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(node as HTMLElement).pointerEvents).toBe("none");

  await chooseOverlay("Off");
  await vi.waitFor(() => {
    expect(chromeNode()).toBeNull();
  });
  screen.unmount();
});

/*
 * THE test the chrome exists to survive.
 *
 * renderSlideCanvas (app.js:4228-4238) draws an export from the document onto a
 * fresh canvas and never reads the page, so the export path here is the
 * ThumbnailRenderer: a function handed a Slide and asked for a PNG. The chrome
 * must contribute nothing to what it receives.
 *
 * The assertion is a positive one and it discriminates. A real edit made while
 * the chrome is up does reach the renderer, and the slide it receives changes
 * because of it, so this can fail. What it must never carry is a word the mock
 * put on screen.
 */
it("never draws the chrome into an export", async () => {
  const stage = world(fixtureProject({ slides: 1, texts: 1 }));
  const screen = await mount(stage);
  await vi.waitFor(() => {
    expect(stage.drawn.length).toBeGreaterThan(0);
  });
  const beforeCount = stage.drawn.length;
  const beforeSlide = stage.drawn.at(-1);

  await chooseOverlay(/^TikTok/);
  await vi.waitFor(() => {
    expect(chromeNode()?.dataset["chrome"]).toBe("tiktok");
  });
  // The mock really is on screen, so this is not a test of an empty stage.
  await expect.element(screen.getByText("PREVIEW ONLY · NOT EXPORTED")).toBeVisible();

  // Turning it on redraws nothing, because nothing the renderer reads changed.
  expect(stage.drawn).toHaveLength(beforeCount);

  /*
   * The discriminator. One real edit, made through the inspector while the
   * chrome is up, so the assertion below is one that can fail.
   */
  const layer = document.querySelector<HTMLElement>('[data-layer-kind="text"]');
  if (layer === null) throw new Error("The slide has no text layer.");
  await userEvent.click(layer);
  await expect.element(screen.getByPlaceholder("Type something…")).toBeVisible();
  await userEvent.fill(screen.getByPlaceholder("Type something…"), "Chrome is up");

  await vi.waitFor(() => {
    expect(stage.drawn.length).toBeGreaterThan(beforeCount);
  });
  const afterSlide = stage.drawn.at(-1);
  expect(afterSlide).not.toEqual(beforeSlide);
  expect(afterSlide?.texts[0]?.text).toBe("Chrome is up");

  // And nothing the mock draws reached the renderer, on either pass.
  const seen = JSON.stringify(stage.drawn);
  for (const word of CHROME_WORDS) expect(seen).not.toContain(word);
  screen.unmount();
});

/* app.js:1794-1796. The dots and the counter belong to a carousel only. */
it("counts the slides only when there is more than one", async () => {
  const stage = world(fixtureProject({ slides: 3 }));
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();

  await chooseOverlay(/^Instagram feed/);

  await vi.waitFor(() => {
    expect(chromeNode()?.dataset["chrome"]).toBe("instagram-feed");
  });
  await expect.element(screen.getByText("1/3")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Open slide 2" }));
  await expect.element(screen.getByText("2/3")).toBeVisible();
  screen.unmount();
});

it("draws no counter on a single slide", async () => {
  const stage = world(fixtureProject({ slides: 1 }));
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();

  await chooseOverlay(/^Instagram feed/);

  await vi.waitFor(() => {
    expect(chromeNode()?.dataset["chrome"]).toBe("instagram-feed");
  });
  expect(document.body.textContent).not.toContain("1/1");
  screen.unmount();
});

/*
 * The mock is authored at OUTPUT_WIDTH and scaled onto the stage, so its inner
 * canvas has to end up exactly as wide as the stage however wide that is.
 */
it("scales the mock onto the stage", async () => {
  const stage = world(fixtureProject());
  const screen = await mount(stage);
  await expect
    .element(screen.getByRole("button", { name: "Choose the UI preview overlay" }))
    .toBeVisible();

  await chooseOverlay(/^Instagram Stories/);

  await vi.waitFor(() => {
    expect(chromeNode()?.dataset["chrome"]).toBe("instagram-story");
  });
  const overlay = chromeNode();
  if (overlay === null) throw new Error("The chrome did not mount.");
  const slideCanvas = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (slideCanvas === null) throw new Error("The editor has no stage.");
  await vi.waitFor(() => {
    const canvas = overlay.firstElementChild;
    if (canvas === null) throw new Error("The chrome has no canvas.");
    const canvasWidth = canvas.getBoundingClientRect().width;
    const overlayWidth = overlay.getBoundingClientRect().width;
    expect(overlayWidth).toBeGreaterThan(0);
    expect(canvasWidth).toBeCloseTo(overlayWidth, 0);
    expect(getComputedStyle(canvas).width).toBe(`${String(OUTPUT_WIDTH)}px`);
    /*
     * Against the stage itself, not only against the overlay. Measuring the
     * mock against its own box proves it scales consistently within itself and
     * would still pass if the overlay drifted off the slide. "The overlay
     * covers the stage exactly" is the claim that licenses measuring here
     * instead of reading --stage-scale, so it is the claim asserted.
     */
    expect(overlayWidth).toBeCloseTo(slideCanvas.getBoundingClientRect().width, 0);
  });
  screen.unmount();
});
