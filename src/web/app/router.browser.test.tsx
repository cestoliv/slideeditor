import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../design/tokens.css";
import "../design/reset.css";
import { ToastProvider } from "../design/index.js";
import { ProjectsProvider } from "./projects.js";
import type { Subscribe } from "./projects.js";
import { AppRoutes } from "./router.js";

/*
 * The routing table, with the server stubbed at the module boundary. The
 * provider takes its client from api.js by default, so mocking that module is
 * what proves the default wiring rather than the test's own injection.
 *
 * Only the calls are replaced. ApiError stays the real class, because the
 * library admin narrows a failed delete with `instanceof` and a stubbed
 * lookalike would never match.
 */
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  api: {
    listProjects: () => Promise.resolve({ projects: [] }),
    createProject: () =>
      Promise.resolve({
        project: {
          id: "p-new",
          name: "New Project",
          version: 1,
          status: "draft",
          createdAt: 1,
          updatedAt: 1,
          ratio: { w: 9, h: 16 },
          slides: [],
        },
      }),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
    /* The editor opens the slideshow the path names. */
    getProject: (id: string) =>
      Promise.resolve({
        project: {
          id,
          // The name carries the id back, so a field holding it proves the
          // path segment reached the client whole and unescaped.
          name: `Slideshow ${id}`,
          version: 1,
          status: "draft",
          createdAt: 1,
          updatedAt: 1,
          ratio: { w: 9, h: 16 },
          slides: [
            {
              id: "slide-1",
              backgroundItemId: "item-1",
              name: "Slide 1",
              width: 1080,
              height: 1920,
              imageScale: 1,
              imageX: 0,
              imageY: 0,
              overlays: [],
              texts: [],
            },
          ],
        },
      }),
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
    session: () => Promise.resolve({ authenticated: true, mode: "open" }),
  },
  isUnauthorized: () => false,
}));

/*
 * The editor subscribes to the server-sent stream on mount, and a real
 * EventSource here would open a request against the test server and retry it
 * for the life of the file. The dashboard's provider is injected instead, which
 * is why only this one needs mocking.
 */
vi.mock("./events.js", () => ({ subscribeToServerEvents: () => () => {} }));

const noStream: Subscribe = () => () => {};

async function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ProjectsProvider subscribe={noStream}>
          <AppRoutes />
        </ProjectsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

it("renders the dashboard at the root", async () => {
  const screen = await at("/");
  await expect
    .element(screen.getByRole("heading", { name: "Your slideshows" }))
    .toBeVisible();
});

/*
 * The editor was built, reviewed over five rounds, and left unroutable: this
 * path rendered a placeholder, so nothing any of it built could be opened by a
 * person. Every assertion below names something only the real editor draws, so
 * putting a placeholder back reddens the lot rather than slipping through on a
 * heading that both screens happen to share.
 */
it("routes a slideshow id to the real editor", async () => {
  const screen = await at("/projects/abc%20123");

  // The header's own field, holding the name the server answered with.
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Slideshow abc 123");
  // The slide rail, with the slideshow's one slide in it.
  await expect
    .element(screen.getByRole("button", { name: "Open slide 1" }))
    .toBeVisible();
  // The stage's own actions.
  await expect
    .element(screen.getByRole("button", { name: "Adjust photo" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Reset canvas zoom" }))
    .toBeVisible();
  // And the canvas itself, which is what the whole screen exists to show.
  expect(document.querySelector('[data-testid="stage"]')).not.toBe(null);
});

it("hands the editor the id from the path, unescaped", async () => {
  const screen = await at("/projects/abc%20123");
  // The mock names the slideshow after the id it was asked for, so this field
  // reads back the whole round trip: the segment reached the route, was
  // unescaped, and was handed to the editor rather than dropped.
  await expect
    .element(screen.getByRole("textbox", { name: "Slideshow name" }))
    .toHaveValue("Slideshow abc 123");
  await expect
    .element(screen.getByRole("link", { name: "Go to slideshows" }))
    .toBeVisible();
  expect(document.title).toBe("Slideshow abc 123 · Slide Studio");
});

it("sends the bare library path to the backgrounds tab", async () => {
  const screen = await at("/library");
  await expect
    .element(screen.getByRole("heading", { name: "Backgrounds" }))
    .toBeVisible();
});

it("routes the assets tab by its own path", async () => {
  const screen = await at("/library/assets");
  await expect.element(screen.getByRole("heading", { name: "Assets" })).toBeVisible();
});

it("refuses a library kind it does not have", async () => {
  const screen = await at("/library/stickers");
  await expect
    .element(screen.getByRole("heading", { name: "Nothing lives here." }))
    .toBeVisible();
});

it("answers an unknown path with the not-found screen", async () => {
  const screen = await at("/nowhere");
  await expect
    .element(screen.getByRole("heading", { name: "Nothing lives here." }))
    .toBeVisible();
});

it("mounts the design gallery in development", async () => {
  expect(import.meta.env.DEV).toBe(true);
  const screen = await at("/design");
  await expect.element(screen.getByRole("heading", { name: "Tokens" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Overlays" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Menus" })).toBeVisible();
});

it("puts the brand on every screen", async () => {
  const screen = await at("/nowhere");
  await expect
    .element(screen.getByRole("link", { name: "Go to slideshows" }))
    .toBeVisible();
});
