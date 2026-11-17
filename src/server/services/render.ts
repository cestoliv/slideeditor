import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "../auth/cookie.js";

/*
 * Renders a ready slideshow on the server, so export_slideshow does not wait
 * for someone to open the editor.
 *
 * The pixels come from the same canvas code the editor uploads with
 * (src/web/render.ts runs publishRenders), drawn by headless Chromium. The page
 * lives on a made-up origin, and every request it makes is answered in this
 * process through app.inject, so the render needs no open port and goes
 * through the same routes, guard included, as a signed-in editor. The session
 * it signs in with lives only as long as the render.
 */

const ORIGIN = "http://localhost";

/**
 * A launch plus a render stays under 45 s, below the MCP SDK's 60 s request
 * timeout, so a stuck render answers pending rather than leaving the agent's
 * call to time out.
 */
const LAUNCH_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 30_000;

/** The response headers the page needs. Nothing else crosses the bridge. */
const FORWARDED_HEADERS = ["content-type", "content-length", "cache-control"];

export type ServerRender = (id: string, version: number) => Promise<void>;

/**
 * One render at a time, server wide, because each one holds a Chromium and
 * full resolution canvases. A second call for a version already being drawn
 * waits on that run rather than drawing it twice.
 */
export function createServerRender(app: FastifyInstance): ServerRender {
  const running = new Map<string, Promise<void>>();
  // ponytail: one global queue, and time spent waiting in it counts against
  // the caller's MCP timeout. Allow a few in parallel if exports pile up.
  let queue: Promise<unknown> = Promise.resolve();
  return (id, version) => {
    const key = `${id}:${String(version)}`;
    let run = running.get(key);
    if (run === undefined) {
      run = queue
        .catch(() => undefined)
        .then(() => renderInBrowser(app, id, version))
        .finally(() => running.delete(key));
      queue = run;
      running.set(key, run);
    }
    return run;
  };
}

/**
 * Chromium with its home under the temp directory. A container with a
 * read-only root has no writable home, and Chromium's crash handler aborts
 * the launch without one. Exported for the CI check that launches it inside
 * the image.
 */
export function launchBrowser(): Promise<Browser> {
  const executablePath = process.env["SLIDE_STUDIO_CHROMIUM"];
  const home = tmpdir();
  return chromium.launch({
    timeout: LAUNCH_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
    },
    ...(executablePath ? { executablePath } : {}),
  });
}

async function renderInBrowser(
  app: FastifyInstance,
  id: string,
  version: number,
): Promise<void> {
  // ponytail: one browser per render, closed after. Keep one alive if launch
  // time ever matters more than the memory it holds between exports.
  const browser = await launchBrowser();
  const session = app.sessions.create({ userAgent: "slide-studio server render" });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `The server render took longer than ${String(RENDER_TIMEOUT_MS / 1000)} s.`,
          ),
        );
      }, RENDER_TIMEOUT_MS);
    });
    await Promise.race([drawInPage(app, browser, session, id, version), timeout]);
  } finally {
    clearTimeout(timer);
    app.sessions.revoke(session);
    // Closing the browser also settles whatever the page was still waiting on.
    await browser.close();
  }
}

async function drawInPage(
  app: FastifyInstance,
  browser: Browser,
  session: string,
  id: string,
  version: number,
): Promise<void> {
  const page = await browser.newPage();
  // The page holds a signed-in session, so it reaches nothing but this server.
  // Routes registered later take precedence, so this one only sees the rest.
  await page.route("**/*", (route) => route.abort());
  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataBuffer();
      const response = await app.inject({
        method: request.method() as "GET" | "HEAD" | "POST" | "PUT",
        url: url.pathname + url.search,
        headers: {
          ...request.headers(),
          host: "localhost",
          cookie: `${SESSION_COOKIE}=${session}`,
        },
        ...(body === null ? {} : { payload: body }),
      });
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_HEADERS) {
        const value = response.headers[name];
        if (value !== undefined) headers[name] = String(value);
      }
      await route.fulfill({
        status: response.statusCode,
        headers,
        body: response.rawPayload,
      });
    } catch {
      // An unanswered request would leave the page waiting until the timeout.
      await route.abort().catch(() => undefined);
    }
  });
  const response = await page.goto(`${ORIGIN}/render.html`);
  if (response === null || !response.ok()) {
    throw new Error(
      "The server has no render page. Build the client with `npm run build:web`.",
    );
  }
  await page.evaluate(
    async ([slideshow, at]) => {
      // Declared by src/web/render.ts, which this compile does not see.
      const page = window as unknown as {
        renderSlideshow: (id: string, version: number) => Promise<number>;
      };
      await page.renderSlideshow(slideshow, at);
    },
    [id, version] as const,
  );
}
