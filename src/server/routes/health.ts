import type { FastifyInstance } from "fastify";

export function healthRoutes(app: FastifyInstance): void {
  app.get("/api/health", () => ({ ok: true, name: "slide-studio" }));
}
