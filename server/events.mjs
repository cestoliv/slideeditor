const HEARTBEAT_MS = 25000;

/** Server-sent events, so an open editor learns when an agent changes a slideshow. */
export class EventBus {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.send(": ping\n\n"), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  subscribe(request, response) {
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

  broadcast(payload) {
    this.send(`data: ${JSON.stringify(payload)}\n\n`);
  }

  send(frame) {
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
