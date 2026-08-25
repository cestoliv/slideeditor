import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { authEvents } from "./api.js";
import { useSession } from "./session.js";

/*
 * api.js is mocked only on `api`, not on `authEvents`: the whole point of the
 * third test below is that a *real* event, dispatched from outside React,
 * reaches this hook and makes it re-probe.
 */
const session = vi.fn();
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  api: { session: (...args: unknown[]) => session(...args) },
}));

beforeEach(() => {
  session.mockReset();
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

it("hands back a refresh a caller can drive by hand", async () => {
  session.mockResolvedValue({ authenticated: true, mode: "open" });
  let refresh: (() => void) | undefined;
  await render(<Probe onRefresh={(fn) => (refresh = fn)} />);
  await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(1));
  refresh?.();
  await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2));
});
