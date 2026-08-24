import { afterEach, expect, it, vi } from "vitest";
import { setAccessToken } from "./api.js";
import { subscribeToServerEvents } from "./events.js";
import type { EventStream, ServerEvent, StreamStatus } from "./events.js";

/** Stands in for the real stream, so a test pushes frames instead of a server. */
class FakeStream extends EventTarget implements EventStream {
  closed = false;
  /* EventSource: 0 CONNECTING, 1 OPEN, 2 CLOSED. */
  readyState = 1;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  push(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  connect(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  /** The browser has given up: a non-2xx answer fails the connection for good. */
  fail(): void {
    this.readyState = 2;
    this.dispatchEvent(new Event("error"));
  }

  /** A drop the browser intends to retry. */
  drop(): void {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  }
}

function openStream(
  onEvent: (event: ServerEvent) => void,
  onStatus?: (status: StreamStatus) => void,
) {
  let stream: FakeStream | null = null;
  const stop = subscribeToServerEvents(onEvent, {
    create: (url) => {
      stream = new FakeStream(url);
      return stream;
    },
    ...(onStatus === undefined ? {} : { onStatus }),
  });
  if (stream === null) throw new Error("subscribeToServerEvents opened no stream.");
  return { stop, stream: stream as FakeStream };
}

/**
 * Whatever exceptions escaped a listener while `body` ran.
 *
 * dispatchEvent does not hand a listener's exception back to its caller, so a
 * frame that throws inside onMessage is indistinguishable from one that was
 * correctly dropped: both leave the spy uncalled, and both leave the listener
 * registered so the next frame still arrives. The browser reports the escaped
 * exception at the global scope instead, and that is the one signal that
 * separates the two.
 */
function escapedErrors(body: () => void): string[] {
  const escaped: string[] = [];
  const capture = (event: ErrorEvent): void => {
    escaped.push(String(event.message));
  };
  window.addEventListener("error", capture);
  try {
    body();
  } finally {
    window.removeEventListener("error", capture);
  }
  return escaped;
}

afterEach(() => {
  setAccessToken(null);
});

it("opens the stream with no token when it has none", () => {
  const { stream, stop } = openStream(() => {});
  expect(stream.url).toBe("/api/events");
  stop();
});

it("passes the token in the query, because EventSource cannot set a header", () => {
  setAccessToken("lan secret/1");
  const { stream, stop } = openStream(() => {});
  expect(stream.url).toBe("/api/events?token=lan%20secret%2F1");
  stop();
});

it("hands a project.changed frame to the listener", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  stream.push(JSON.stringify({ type: "project.changed", projectId: "p1", version: 7 }));
  expect(seen).toHaveBeenCalledWith({
    type: "project.changed",
    projectId: "p1",
    version: 7,
  });
  stop();
});

it("reads a status frame through the shared status schema", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  stream.push(
    JSON.stringify({ type: "project.status", projectId: "p1", status: "ready" }),
  );
  expect(seen).toHaveBeenCalledWith({
    type: "project.status",
    projectId: "p1",
    status: "ready",
  });
  stop();
});

it("reads a removal frame", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  stream.push(JSON.stringify({ type: "project.removed", projectId: "p1" }));
  expect(seen).toHaveBeenCalledWith({ type: "project.removed", projectId: "p1" });
  stop();
});

it("drops a frame that is not JSON", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  // A real server sends `: ping` keepalive comments routinely, so this has to
  // be inert rather than merely silent.
  const escaped = escapedErrors(() => {
    stream.push(": ping");
  });
  expect(escaped).toEqual([]);
  expect(seen).not.toHaveBeenCalled();
  stop();
});

it("drops a frame this client does not model", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  // Same trap as the comment frame above: parsing these with `.parse` rather
  // than `.safeParse` would throw, the browser would swallow it, and a bare
  // "nothing arrived" assertion would go on passing.
  const escaped = escapedErrors(() => {
    stream.push(JSON.stringify({ type: "library.changed", itemId: "i1" }));
    stream.push(JSON.stringify({ type: "project.changed", projectId: "p1" }));
  });
  expect(escaped).toEqual([]);
  expect(seen).not.toHaveBeenCalled();
  stop();
});

it("closes the stream and stops listening when the subscription is dropped", () => {
  const seen = vi.fn();
  const { stream, stop } = openStream(seen);
  stop();
  expect(stream.closed).toBe(true);
  // Same dispatchEvent path as the two frame tests, so the same trap applies.
  const escaped = escapedErrors(() => {
    stream.push(JSON.stringify({ type: "project.removed", projectId: "p1" }));
  });
  expect(escaped).toEqual([]);
  expect(seen).not.toHaveBeenCalled();
});

it("says the stream closed when the browser gives up on it", () => {
  // A rejected token gets a 401, which fails an EventSource for good. Without
  // this the editor keeps showing stale slideshows and never says why.
  const seen: StreamStatus[] = [];
  const { stream, stop } = openStream(
    () => {},
    (status) => seen.push(status),
  );
  stream.fail();
  expect(seen).toEqual(["closed"]);
  stop();
});

it("does not call a retryable drop a closed stream", () => {
  const seen: StreamStatus[] = [];
  const { stream, stop } = openStream(
    () => {},
    (status) => seen.push(status),
  );
  stream.drop();
  expect(seen).toEqual(["retrying"]);
  stop();
});

it("says the stream is open again once it reconnects", () => {
  const seen: StreamStatus[] = [];
  const { stream, stop } = openStream(
    () => {},
    (status) => seen.push(status),
  );
  stream.drop();
  stream.connect();
  expect(seen).toEqual(["retrying", "open"]);
  stop();
});

it("stops reporting status once the subscription is dropped", () => {
  const seen: StreamStatus[] = [];
  const { stream, stop } = openStream(
    () => {},
    (status) => seen.push(status),
  );
  stop();
  const escaped = escapedErrors(() => {
    stream.fail();
  });
  expect(escaped).toEqual([]);
  expect(seen).toEqual([]);
});
