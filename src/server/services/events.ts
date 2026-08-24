import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../../shared/schema/index.js";

const HEARTBEAT_MS = 25000;

// Declared in @shared/schema so the browser parses the same union this builds.
export type { ServerEvent };

/** Server-sent events, so an open editor learns when an agent changes a slideshow. */
export class EventBus {
  /**
   * Public, as it was in server/events.mjs:6. A test cannot otherwise see that
   * a client which went away was reaped, and the reaping is the only thing
   * keeping this set from growing once per editor tab ever opened.
   */
  readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => this.send(": ping\n\n"), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  subscribe(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 2000\n\n");
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  broadcast(payload: ServerEvent): void {
    this.send(`data: ${JSON.stringify(payload)}\n\n`);
  }

  send(frame: string): void {
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
