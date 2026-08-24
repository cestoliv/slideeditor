import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

const document = {
  ratio: { w: 4, h: 5 },
  slides: [{ id: "s1", backgroundItemId: null, name: "Slide 1" }],
};

async function createProject(name = "Trip"): Promise<{ id: string; version: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name, document },
  });
  expect(response.statusCode).toBe(200);
  return {
    id: String(response.json().project.id),
    version: Number(response.json().project.version),
  };
}

it("creates a project at version 1 and reads it back", async () => {
  const { id } = await createProject();
  const response = await app.inject({ method: "GET", url: `/api/projects/${id}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().project).toMatchObject({
    id,
    name: "Trip",
    version: 1,
    status: "draft",
    ratio: { w: 4, h: 5 },
  });
});

it("names an unnamed project the way the old server did", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {},
  });
  expect(response.json().project.name).toBe("New Project");
});

it("reads an empty body as an empty object, the way readJson did", async () => {
  for (const payload of ["", " ", "\n"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode, JSON.stringify(payload)).toBe(200);
    expect(response.json().project.name).toBe("New Project");
  }
});

it("answers 404 for a project that is not there", async () => {
  const response = await app.inject({ method: "GET", url: "/api/projects/nope" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("No slideshow with id nope");
});

it("saves a matching version and bumps it", async () => {
  const { id } = await createProject();
  const response = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { name: "Trip 2", document, version: 1 },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().project).toMatchObject({ name: "Trip 2", version: 2 });
});

it("returns 409 and the current project when the version is stale", async () => {
  const { id } = await createProject();
  await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { document, version: 1 },
  });

  const response = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { document, version: 1 },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ currentVersion: 2 });
  expect(response.json().project.id).toBe(id);
  expect(response.json().error).toBe("This slideshow changed since you loaded it.");
});

it("treats a save with no version as stale", async () => {
  const { id } = await createProject();
  const response = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { document },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().currentVersion).toBe(1);
});

it("keeps a slide field the rewrite does not model", async () => {
  const { id } = await createProject();
  const odd = { ratio: { w: 9, h: 16 }, slides: [{ id: "s1", mystery: "keep me" }] };
  await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { document: odd, version: 1 },
  });
  const response = await app.inject({ method: "GET", url: `/api/projects/${id}` });
  expect(response.json().project.slides[0].mystery).toBe("keep me");
});

it("sets a status without touching the version", async () => {
  const { id } = await createProject();
  const response = await app.inject({
    method: "PATCH",
    url: `/api/projects/${id}/status`,
    payload: { status: "ready" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().project).toMatchObject({ status: "ready", version: 1 });
});

it("rejects an unknown status with 400", async () => {
  const { id } = await createProject();
  const response = await app.inject({
    method: "PATCH",
    url: `/api/projects/${id}/status`,
    payload: { status: "archived" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("Unknown status: archived");
});

it("lists drafts and ready work, and everything on demand", async () => {
  const draft = await createProject("Draft");
  const done = await createProject("Done");
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${done.id}/status`,
    payload: { status: "published" },
  });

  const listed = await app.inject({ method: "GET", url: "/api/projects" });
  expect(listed.json().projects.map((project: { id: string }) => project.id)).toEqual([
    draft.id,
  ]);

  const all = await app.inject({ method: "GET", url: "/api/projects?status=all" });
  expect(all.json().projects).toHaveLength(2);
});

it("rejects an unknown status filter with 400", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/projects?status=archived",
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("Unknown status filter");
});

it("removes a project", async () => {
  const { id } = await createProject();
  const response = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ removed: id });
  expect(
    (await app.inject({ method: "GET", url: `/api/projects/${id}` })).statusCode,
  ).toBe(404);
});

it("saves the caption the editor types and keeps it through a plain save", async () => {
  const { id } = await createProject();
  const written = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: {
      name: "Trip",
      document,
      version: 1,
      description: "Five things to know first",
      hashtags: "travel, #Summer",
    },
  });
  expect(written.statusCode).toBe(200);
  expect(written.json().project.description).toBe("Five things to know first");
  expect(written.json().project.hashtags).toBe("#travel #Summer");

  // A save that says nothing about the caption leaves it where it is.
  const again = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { name: "Trip", document, version: 2 },
  });
  expect(again.json().project.description).toBe("Five things to know first");
  expect(again.json().project.hashtags).toBe("#travel #Summer");
});

it("lists the caption beside the name, so a screen never has to open a project for it", async () => {
  const { id } = await createProject();
  await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    payload: { document, version: 1, description: "Posted this morning", hashtags: "am" },
  });
  const listed = await app.inject({ method: "GET", url: "/api/projects" });
  expect(listed.json().projects[0]).toMatchObject({
    id,
    description: "Posted this morning",
    hashtags: "#am",
  });
});
