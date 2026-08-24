import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
import { ProjectsProvider } from "../../app/projects.js";
import type { Subscribe } from "../../app/projects.js";
import { AppRoutes } from "../../app/router.js";

/*
 * The library admin as the app itself reaches it. Everything else in this
 * feature mounts the page directly, which proves nothing about whether a person
 * can open it: a screen wired to no route is a screen nobody sees.
 *
 * The server is stubbed at the module boundary, so what is under test is the
 * app's own default wiring rather than an injection this file made up.
 */
vi.mock("../../app/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/api.js")>()),
  api: {
    listProjects: () => Promise.resolve({ projects: [] }),
    listLibrary: () =>
      Promise.resolve({
        items: [
          {
            id: "b1",
            kind: "background",
            name: "Golden hour",
            description: "",
            usage: "",
            tags: [],
            mediaId: "b1",
            ext: "png",
            url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
            width: 1080,
            height: 1920,
            createdAt: 1,
            updatedAt: 1,
            stats: {
              timesUsed: 0,
              slideshowCount: 0,
              firstUsedAt: null,
              lastUsedAt: null,
            },
          },
          {
            id: "a1",
            kind: "asset",
            name: "Corner logo",
            description: "",
            usage: "",
            tags: [],
            mediaId: "a1",
            ext: "png",
            url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
            width: 200,
            height: 200,
            createdAt: 1,
            updatedAt: 1,
            stats: {
              timesUsed: 0,
              slideshowCount: 0,
              firstUsedAt: null,
              lastUsedAt: null,
            },
          },
        ],
        total: 2,
      }),
  },
  isUnauthorized: () => false,
  getAccessToken: () => null,
}));

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

it("opens the backgrounds admin page at its own path", async () => {
  const screen = await at("/library/backgrounds");
  // The grid, not a heading: a placeholder can carry the same title.
  await expect
    .element(screen.getByRole("button", { name: "Delete Golden hour" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("searchbox", { name: "Search the library" }))
    .toBeVisible();
  // The kind reached the page, rather than the page defaulting to one.
  await expect
    .element(screen.getByRole("button", { name: "Upload backgrounds" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Corner logo" }))
    .not.toBeInTheDocument();
});

it("opens the assets admin page at its own path", async () => {
  const screen = await at("/library/assets");
  await expect
    .element(screen.getByRole("button", { name: "Delete Corner logo" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Upload assets" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete Golden hour" }))
    .not.toBeInTheDocument();
});

it("sends the bare library path to the backgrounds admin page", async () => {
  const screen = await at("/library");
  await expect
    .element(screen.getByRole("button", { name: "Delete Golden hour" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Upload backgrounds" }))
    .toBeVisible();
});

it("walks from the dashboard to the library and back", async () => {
  // The whole path a person takes, through the header link the dashboard puts
  // there rather than through an address typed by hand.
  const screen = await at("/");
  await screen.getByRole("link", { name: "Library" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Upload backgrounds" }))
    .toBeVisible();

  await screen.getByRole("link", { name: "Assets" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Upload assets" }))
    .toBeVisible();

  await screen.getByRole("link", { name: "Go to slideshows" }).click();
  await expect
    .element(screen.getByRole("heading", { name: "Your slideshows" }))
    .toBeVisible();
});

it("gives each tab a fresh page rather than the last one's search", async () => {
  /*
   * Both tabs are the one route `/library/:kind`, so React reconciles the same
   * component in the same place and keeps its state unless it is told not to.
   * A search typed on backgrounds silently filtering the assets tab is the kind
   * of thing only the real routing table can show: the feature's own tests wire
   * the two kinds as separate elements, which remount on their own.
   */
  const screen = await at("/library/backgrounds");
  await expect
    .element(screen.getByRole("button", { name: "Delete Golden hour" }))
    .toBeVisible();

  await screen.getByRole("searchbox", { name: "Search the library" }).fill("golden");
  await screen.getByRole("link", { name: "Assets" }).click();

  await expect
    .element(screen.getByRole("searchbox", { name: "Search the library" }))
    .toHaveValue("");
  await expect
    .element(screen.getByRole("button", { name: "Delete Corner logo" }))
    .toBeVisible();
});

it("still refuses a library kind it does not have", async () => {
  const screen = await at("/library/stickers");
  await expect
    .element(screen.getByRole("heading", { name: "Nothing lives here." }))
    .toBeVisible();
});
