import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { EventBus } from "./events.js";

let running: { bus: EventBus; server: Server } | undefined;
afterEach(async () => {
  running?.bus.close();
  await new Promise((resolve) => running?.server.close(resolve));
  running = undefined;
});

/** A real server, because subscribe writes to a raw ServerResponse. */
async function listen(): Promise<{ bus: EventBus; url: string }> {
  const bus = new EventBus();
  const server = createServer((request, response) => bus.subscribe(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("The test server has no port.");
  running = { bus, server };
  return { bus, url: `http://127.0.0.1:${address.port}/api/events` };
}

interface Stream {
  text(): string;
  ended(): boolean;
  cancel(): Promise<void>;
}

/**
 * Drains the response in the background. A test that instead read on demand
 * would leave a pending read behind whenever it asserted that nothing arrived,
 * and that read would swallow the next frame.
 */
function drain(response: Response): Stream {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } catch {
      // The test cancelled the reader.
    }
    ended = true;
  })();
  return { text: () => text, ended: () => ended, cancel: () => reader.cancel() };
}

/** Polls on the real clock, so it works while the interval is faked. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function open(url: string): Promise<Stream> {
  const stream = drain(await fetch(url));
  await waitFor(() => stream.text() === "retry: 2000\n\n", "the stream to open");
  return stream;
}

it("opens the stream with the right headers and a retry hint", async () => {
  const { url } = await listen();
  const response = await fetch(url);

  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("connection")).toBe("keep-alive");
  expect(response.headers.get("x-accel-buffering")).toBe("no");

  const stream = drain(response);
  await waitFor(() => stream.text() === "retry: 2000\n\n", "the retry hint");
  await stream.cancel();
});

it("sends a broadcast to every subscriber as one data frame", async () => {
  const { bus, url } = await listen();
  const first = await open(url);
  const second = await open(url);

  bus.broadcast({ type: "project.changed", projectId: "abc", version: 4 });

  const expected =
    'retry: 2000\n\ndata: {"type":"project.changed","projectId":"abc","version":4}\n\n';
  await waitFor(() => first.text() === expected, "the first subscriber's frame");
  await waitFor(() => second.text() === expected, "the second subscriber's frame");
  await first.cancel();
  await second.cancel();
});

it("forgets a client that has gone away", async () => {
  const { bus, url } = await listen();
  const controller = new AbortController();
  const kept = await open(url);
  const going = drain(await fetch(url, { signal: controller.signal }));
  await waitFor(() => bus.clients.size === 2, "both subscribers to register");

  controller.abort();
  // Nothing here can assert on a write instead: write to a destroyed socket
  // reports asynchronously and never throws, so the close handler is the only
  // reaping there is.
  await waitFor(() => bus.clients.size === 1, "the dead client to be reaped");

  bus.broadcast({ type: "project.removed", projectId: "gone" });
  await waitFor(() => kept.text().includes('"project.removed"'), "the survivor's frame");
  expect(going.ended(), "and the client that left is done").toBe(true);
  await kept.cancel();
});

it("pings an idle stream every 25 seconds", async () => {
  // Only the interval is faked, so the real socket below still delivers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { url } = await listen();
    const stream = await open(url);

    await vi.advanceTimersByTimeAsync(24999);
    await sleep(50);
    expect(stream.text(), "nothing before the interval elapses").toBe("retry: 2000\n\n");

    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => stream.text() === "retry: 2000\n\n: ping\n\n", "the first ping");

    await vi.advanceTimersByTimeAsync(25000);
    await waitFor(
      () => stream.text() === "retry: 2000\n\n: ping\n\n: ping\n\n",
      "the second ping",
    );
    await stream.cancel();
  } finally {
    vi.useRealTimers();
  }
});

it("ends every stream on close", async () => {
  const { bus, url } = await listen();
  const stream = await open(url);

  bus.close();

  expect(
    bus.clients.size,
    "close empties the set at once, without waiting for the sockets",
  ).toBe(0);
  await waitFor(() => stream.ended(), "the client to see the end of the stream");
});
