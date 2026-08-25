import type { FastifyInstance } from "fastify";

export function eventRoutes(app: FastifyInstance): void {
  app.get("/api/events", (request, reply) => {
    // The bus writes the SSE head and keeps the socket open itself, so Fastify
    // hands the response over rather than trying to end it.
    reply.hijack();
    app.events.subscribe(request.raw, reply.raw);
  });
}
