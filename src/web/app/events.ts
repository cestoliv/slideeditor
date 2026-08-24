import { serverEventSchema } from "@shared/schema/index.js";
import type { ServerEvent } from "@shared/schema/index.js";
import { getAccessToken } from "./api.js";

/*
 * The server-sent event stream, so an open editor learns when an agent changes
 * a slideshow. Ported from api.js:100-113.
 */

const EVENTS_PATH = "/api/events";

/*
 * The frames the bus broadcasts are declared in @shared/schema, which the
 * server's EventBus types itself from too, so the two cannot drift.
 */
export { serverEventSchema };
export type { ServerEvent };

/** EventSource.CLOSED. A stream in this state has given up and will not retry. */
const STREAM_CLOSED = 2;

/** Where the stream stands, as far as the browser will say. */
export type StreamStatus = "open" | "retrying" | "closed";

/**
 * The slice of EventSource this module uses. Naming it lets a test drive the
 * stream frame by frame instead of standing a server up to push one.
 */
export interface EventStream {
  readonly readyState: number;
  addEventListener(
    type: "message" | "open" | "error",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: "message" | "open" | "error",
    listener: (event: Event) => void,
  ): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventStream;

export type SubscribeOptions = {
  create?: EventSourceFactory;
  /**
   * Reports the stream coming up and going down. The spec fails an EventSource
   * permanently on a non-2xx answer, with no retry, so a rejected token kills
   * live updates outright and nothing else on screen would ever say so.
   */
  onStatus?: (status: StreamStatus) => void;
};

/** Returns the unsubscribe. The browser reconnects a dropped stream on its own. */
export function subscribeToServerEvents(
  onEvent: (event: ServerEvent) => void,
  options: SubscribeOptions = {},
): () => void {
  const create = options.create ?? ((url: string) => new EventSource(url));
  const token = getAccessToken();
  // EventSource cannot set a header, so a remote page passes the token in the
  // query string. src/server/auth.ts:33-35 accepts it there for this reason
  // alone, and this is the one URL in the client that ever carries it.
  const url =
    token === null ? EVENTS_PATH : `${EVENTS_PATH}?token=${encodeURIComponent(token)}`;
  const stream = create(url);

  const onMessage = (event: Event): void => {
    // EventTarget hands over the base type, and only a message frame has data.
    if (!(event instanceof MessageEvent)) return;
    const parsed = serverEventSchema.safeParse(readFrame(String(event.data)));
    // Heartbeats carry no payload, and a frame this client does not model is
    // not an error either, so both are dropped rather than thrown.
    if (parsed.success) onEvent(parsed.data);
  };

  const onOpen = (): void => {
    options.onStatus?.("open");
  };

  const onError = (): void => {
    // The browser fires error both for a drop it intends to retry and for one
    // it has given up on. Only the second is worth telling anyone about.
    options.onStatus?.(stream.readyState === STREAM_CLOSED ? "closed" : "retrying");
  };

  stream.addEventListener("message", onMessage);
  stream.addEventListener("open", onOpen);
  stream.addEventListener("error", onError);
  return () => {
    stream.removeEventListener("message", onMessage);
    stream.removeEventListener("open", onOpen);
    stream.removeEventListener("error", onError);
    stream.close();
  };
}

function readFrame(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}
