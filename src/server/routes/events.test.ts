import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await app.close();
});

function baseUrl(): string {
  const address = app.addresses()[0];
  if (!address) throw new Error("The test server is not listening.");
  return `http://127.0.0.1:${address.port}`;
}

it("streams what an agent changes to an open editor", async () => {
  const stream = await fetch(`${baseUrl()}/api/events`);
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(stream.headers.get("cache-control")).toBe("no-cache, no-transform");

  const reader = stream.body?.getReader();
  if (!reader) throw new Error("The event stream carried no body.");
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  expect(text).toContain("retry: 2000");

  const created = await fetch(`${baseUrl()}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Trip", accountId: "default" }),
  });
  const project = (await created.json()) as { project: { id: string } };

  while (!text.includes("project.changed")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("The stream ended before the event arrived.");
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain(`"projectId":"${project.project.id}"`);
  await reader.cancel();
});
