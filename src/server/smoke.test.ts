import { expect, it } from "vitest";
import { makeTempApp } from "./testing.js";

it("answers the health check", async () => {
  const app = await makeTempApp();
  const response = await app.inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, name: "slide-studio" });
  await app.close();
});
