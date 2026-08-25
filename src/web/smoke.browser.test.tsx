import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { App } from "./App.js";

/*
 * The whole app, mounted the way index.html mounts it.
 *
 * Both modules that reach the network are stubbed. Rendering the real <App/>
 * used to fire a live fetch at /api/projects and open a live EventSource on
 * /api/events against the vitest dev server, which answers neither: the test
 * passed on the failures being harmless rather than on there being none.
 */
/*
 * Only the calls are replaced. ApiError stays the real class, because the
 * library admin the router now mounts narrows a failed delete with `instanceof`
 * and a stubbed lookalike would never match.
 */
vi.mock("./app/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app/api.js")>()),
  api: {
    listProjects: () => Promise.resolve({ projects: [] }),
    createProject: () => Promise.reject(new Error("not part of this test")),
    deleteProject: (id: string) => Promise.resolve({ removed: id }),
    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
  },
  isUnauthorized: () => false,
  getAccessToken: () => null,
}));

vi.mock("./app/events.js", () => ({
  subscribeToServerEvents: () => () => {},
}));

it("renders the app shell", async () => {
  const screen = await render(<App />);
  await expect.element(screen.getByText("Slide Studio")).toBeVisible();
});

it("puts a working route under the shell", async () => {
  // BrowserRouter reads the runner's own URL, which matches no route, so this
  // lands on the not-found screen. That is still the router doing its job.
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("link", { name: "Go to slideshows" }))
    .toBeVisible();
});
