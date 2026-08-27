import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { authEvents } from "./api.js";
import { resetFontFacesForTesting, weightFor } from "./fontFaces.js";
import { useSession } from "./session.js";

/*
 * api.js is mocked only on `api.session`, not on `authEvents` or the rest of
 * `api`: the whole point of the third test below is that a *real* event,
 * dispatched from outside React, reaches this hook and makes it re-probe,
 * and the font-catalogue test below routes through the real
 * api.listFonts() (fontFaces.ts calls it, not a raw fetch — see finding 9),
 * which only exists to exercise the real error shaping and 401 handling
 * `call()` gives it. Replacing the whole `api` export, the way this used to,
 * left `api.listFonts` undefined the moment fontFaces.ts started calling it.
 */
const session = vi.fn();
vi.mock("./api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api.js")>();
  return {
    ...original,
    api: { ...original.api, session: (...args: unknown[]) => session(...args) },
  };
});

beforeEach(() => {
  session.mockReset();
  // fontFaces.ts's catalogue, inFlight counter and readiness promise are
  // module-level singletons that outlive any one test (see
  // resetFontFacesForTesting's own doc comment) — several tests in this file
  // go authenticated:true and so trigger ensureFontFacesLoaded() themselves,
  // which would otherwise leave a later test seeing a catalogue, or an
  // in-flight guard, some earlier test left behind.
  resetFontFacesForTesting();
  // Stubbed to fail fast by default; a test that actually cares what the
  // fetch returns (below) overrides this with its own vi.stubGlobal.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe({ onRefresh }: { onRefresh?: (refresh: () => void) => void }) {
  const { state, refresh } = useSession();
  onRefresh?.(refresh);
  if (state.status === "loading") return <p>loading</p>;
  if (state.status === "unreachable") return <p>unreachable</p>;
  return (
    <p>
      ready authenticated={String(state.session.authenticated)} mode={state.session.mode}
    </p>
  );
}

it("reports what the server answered once the probe resolves", async () => {
  session.mockResolvedValue({ authenticated: true, mode: "required" });
  const screen = await render(<Probe />);
  await expect
    .element(screen.getByText("ready authenticated=true mode=required"))
    .toBeVisible();
});

it("renders nothing that claims to be ready before the probe answers", async () => {
  // A promise that never settles pins the hook in "loading" for the life of
  // the test, which is the one state that has to render neither "ready" nor
  // "unreachable": either would tell a screen something the probe never said.
  session.mockReturnValue(new Promise(() => undefined));
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("loading")).toBeVisible();
});

it("reports unreachable when the probe itself fails", async () => {
  session.mockRejectedValue(new Error("network down"));
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("unreachable")).toBeVisible();
});

it("re-probes when an unauthorized event fires elsewhere in the app", async () => {
  session.mockResolvedValueOnce({ authenticated: true, mode: "required" });
  const screen = await render(<Probe />);
  await expect
    .element(screen.getByText("ready authenticated=true mode=required"))
    .toBeVisible();

  session.mockResolvedValueOnce({ authenticated: false, mode: "required" });
  authEvents.dispatchEvent(new Event("unauthorized"));

  await expect
    .element(screen.getByText("ready authenticated=false mode=required"))
    .toBeVisible();
  expect(session).toHaveBeenCalledTimes(2);
});

it("fetches the font catalogue only once signed in, and retries it on a successful sign-in", async () => {
  // The bug this covers: injectFontFaces() used to fire once, unconditionally,
  // at module load — above the auth gate. On a password-protected install
  // that fetch 401s, and nothing about signing in afterwards ever asked
  // again, so the catalogue stayed empty (and every weight TEXT_WEIGHT) for
  // the rest of the session.
  session.mockResolvedValueOnce({ authenticated: false, mode: "required" });
  const fontsFetch = vi.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          fonts: [
            {
              id: "1",
              family: "TikTok Sans",
              weight: 500,
              source: "builtin",
              url: "/fonts/tiktok-sans.ttf",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fontsFetch);

  let refresh: (() => void) | undefined;
  const screen = await render(<Probe onRefresh={(fn) => (refresh = fn)} />);
  await expect
    .element(screen.getByText("ready authenticated=false mode=required"))
    .toBeVisible();
  // Not signed in yet, so nothing has asked the server for a font it cannot
  // have.
  expect(fontsFetch).not.toHaveBeenCalled();

  session.mockResolvedValueOnce({ authenticated: true, mode: "required" });
  refresh?.();
  await expect
    .element(screen.getByText("ready authenticated=true mode=required"))
    .toBeVisible();

  await vi.waitFor(() => {
    // api.listFonts() now goes through call(), which passes fetch a second
    // argument (method, headers, credentials, timeout signal) — the path is
    // still what matters here, not the exact options object.
    expect(fontsFetch.mock.calls.some(([path]) => path === "/api/fonts")).toBe(true);
  });
  await vi.waitFor(() => {
    expect(weightFor("TikTok Sans")).toBe(500);
  });
});

it("hands back a refresh a caller can drive by hand", async () => {
  session.mockResolvedValue({ authenticated: true, mode: "open" });
  let refresh: (() => void) | undefined;
  await render(<Probe onRefresh={(fn) => (refresh = fn)} />);
  await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(1));
  refresh?.();
  await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2));
});
