import { afterEach, expect, it, vi } from "vitest";
import type { Project } from "@shared/schema/index.js";
import { ApiError, api, persistProject } from "./api.js";

const realFetch = globalThis.fetch;
const startingUrl = window.location.href;

type Call = { url: string; init: RequestInit | undefined };

/**
 * Answers every request with one response and records what was asked. The suite
 * never reaches a server: the end-to-end project covers the real thing.
 */
function stubFetch(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(reply(call));
  });
  globalThis.fetch = spy;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headerOf(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

function libraryItem(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "item-1",
    kind: "background",
    name: "Sunset",
    description: "",
    usage: "",
    tags: ["warm"],
    mediaId: "media-1",
    ext: "jpg",
    url: "/media/media-1.jpg",
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 2,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
    ...overrides,
  };
}

function storedProject(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "p1",
    name: "Morning routine",
    version: 4,
    status: "draft",
    createdAt: 1,
    updatedAt: 2,
    ratio: { w: 9, h: 16 },
    slides: [],
    ...overrides,
  };
}

function liveProject(): Project {
  return {
    id: "p1",
    name: "Morning routine",
    version: 3,
    status: "draft",
    description: "Five things to know first",
    hashtags: "#travel #summer",
    createdAt: 1,
    updatedAt: 2,
    ratio: { w: 9, h: 16 },
    slides: [],
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  window.history.replaceState({}, "", startingUrl);
});

it("throws an ApiError carrying the server's status and body", async () => {
  stubFetch(() => json({ error: "nope", usedBy: [] }, 409));
  await expect(api.deleteLibraryItem("x")).rejects.toMatchObject({
    status: 409,
    body: { error: "nope", usedBy: [] },
  });
});

it("names the failure with the server's own message", async () => {
  stubFetch(() => json({ error: "No slideshow with id p9" }, 404));
  await expect(api.getProject("p9")).rejects.toThrow("No slideshow with id p9");
});

it("falls back to the status when the body names no error", async () => {
  stubFetch(() => new Response("", { status: 500 }));
  const error = await api.health().catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toBe("Request failed with 500");
});

it("sends the session cookie, and no other, on every request", async () => {
  const calls = stubFetch(() => json({ ok: true, name: "slide-studio" }));
  await api.health();
  expect(calls[0]?.init?.credentials).toBe("same-origin");
  expect(headerOf(calls[0], "Authorization")).toBeNull();
});

it("keeps a hostile id from resolving against another origin", async () => {
  const calls = stubFetch(() => json({ project: storedProject() }));
  // credentials: "same-origin" already keeps the cookie off a cross-origin
  // request, but a path that could still be *resolved* against one is refused
  // outright rather than trusted to fail safely at the network layer.
  await api.getProject("../../https://evil.example/steal");
  const asked = new URL(calls[0]?.url ?? "", window.location.origin);
  expect(asked.origin).toBe(window.location.origin);
  expect(asked.pathname.startsWith("/api/projects/")).toBe(true);
});

it("reports whether this browser is signed in", async () => {
  stubFetch(() => json({ authenticated: true, mode: "required" }));
  await expect(api.session()).resolves.toEqual({ authenticated: true, mode: "required" });
});

it("posts a login and expects nothing back but the cookie", async () => {
  const calls = stubFetch(() => new Response(null, { status: 204 }));
  await api.login("hunter2hunter2");
  expect(calls[0]?.url).toBe("/api/auth/login");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    password: "hunter2hunter2",
  });
});

it("throws the server's refusal on a wrong password", async () => {
  stubFetch(() => json({ error: "That password is not right." }, 401));
  await expect(api.login("wrong")).rejects.toThrow("That password is not right.");
});

it("posts a logout", async () => {
  const calls = stubFetch(() => new Response(null, { status: 204 }));
  await api.logout();
  expect(calls[0]?.url).toBe("/api/auth/logout");
  expect(calls[0]?.init?.method).toBe("POST");
});

it("changes the password", async () => {
  const calls = stubFetch(() => new Response(null, { status: 204 }));
  await api.changePassword("old-password", "a-new-password-1");
  expect(calls[0]?.url).toBe("/api/auth/password");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    current: "old-password",
    next: "a-new-password-1",
  });
});

it("lists tokens, without ever expecting a secret on them", async () => {
  stubFetch(() =>
    json({
      tokens: [
        {
          id: "t1",
          name: "laptop",
          prefix: "sst_abcd",
          createdAt: 1,
          lastUsedAt: null,
          expiresAt: null,
        },
      ],
    }),
  );
  const { tokens } = await api.listTokens();
  expect(tokens[0]?.name).toBe("laptop");
});

it("creates a token and hands back the one-time secret", async () => {
  const calls = stubFetch(() =>
    json({
      token: {
        id: "t1",
        name: "laptop",
        prefix: "sst_abcd",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
      secret: "sst_thesecretvalue",
    }),
  );
  const { secret } = await api.createToken("laptop");
  expect(calls[0]?.url).toBe("/api/auth/tokens");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "laptop" });
  expect(secret).toBe("sst_thesecretvalue");
});

it("deletes a token by its escaped id", async () => {
  const calls = stubFetch(() => json({ removed: "t1" }));
  await api.deleteToken("t1");
  expect(calls[0]?.url).toBe("/api/auth/tokens/t1");
  expect(calls[0]?.init?.method).toBe("DELETE");
});

it("parses a library list through the shared schema", async () => {
  stubFetch(() => json({ items: [libraryItem()], total: 1 }));
  const { items, total } = await api.listLibrary({ kind: "background" });
  expect(total).toBe(1);
  expect(items[0]?.tags).toEqual(["warm"]);
});

it("repairs a library item the way the shared schema does", async () => {
  stubFetch(() => json({ items: [libraryItem({ tags: undefined })], total: 1 }));
  const { items } = await api.listLibrary({});
  expect(items[0]?.tags).toEqual([]);
});

it("rejects a library list the shared schema cannot read", async () => {
  stubFetch(() => json({ items: [{ id: "item-1" }], total: 1 }));
  await expect(api.listLibrary({})).rejects.toThrow();
});

it("sends the library query the server reads", async () => {
  const calls = stubFetch(() => json({ items: [], total: 0 }));
  await api.listLibrary({
    kind: "asset",
    q: "sun",
    sort: "least-used",
    limit: 20,
    offset: 40,
  });
  const url = new URL(calls[0]?.url ?? "", window.location.origin);
  expect(url.pathname).toBe("/api/library");
  expect(url.searchParams.get("kind")).toBe("asset");
  expect(url.searchParams.get("q")).toBe("sun");
  expect(url.searchParams.get("sort")).toBe("least-used");
  expect(url.searchParams.get("limit")).toBe("20");
  expect(url.searchParams.get("offset")).toBe("40");
});

it("forces a library delete only when asked", async () => {
  const calls = stubFetch(() => json({ removed: "item-1", brokeSlideshows: [] }));
  await api.deleteLibraryItem("item-1");
  await api.deleteLibraryItem("item-1", { force: true });
  expect(calls[0]?.url).toBe("/api/library/item-1");
  expect(calls[0]?.init?.method).toBe("DELETE");
  expect(calls[1]?.url).toBe("/api/library/item-1?force=1");
});

it("carries the slideshows a library delete would break", async () => {
  stubFetch(() =>
    json(
      {
        error: "Sunset is used by 1 slideshow.",
        usedBy: [{ id: "p1", name: "Morning" }],
      },
      409,
    ),
  );
  const error = await api.deleteLibraryItem("item-1").catch((thrown: unknown) => thrown);
  expect((error as ApiError).usedBy).toEqual([{ id: "p1", name: "Morning" }]);
});

it("parses a project through the shared schema, layer order included", async () => {
  stubFetch(() =>
    json({
      project: storedProject({
        slides: [
          {
            id: "s1",
            backgroundItemId: "item-1",
            overlays: [{ id: "o1", itemId: "item-1" }],
            texts: [{ id: "t1", value: "Hi" }],
          },
        ],
      }),
    }),
  );
  const { project } = await api.getProject("p1");
  expect(project.slides[0]?.overlays[0]?.z).toBe(1);
  expect(project.slides[0]?.texts[0]?.z).toBe(2);
});

it("asks for every status only when told to", async () => {
  const calls = stubFetch(() => json({ projects: [] }));
  await api.listProjects();
  await api.listProjects("all");
  expect(calls[0]?.url).toBe("/api/projects");
  expect(calls[1]?.url).toBe("/api/projects?status=all");
});

it("patches a slideshow's status", async () => {
  const calls = stubFetch(() => json({ project: storedProject({ status: "ready" }) }));
  const { project } = await api.setProjectStatus("p1", "ready");
  expect(calls[0]?.url).toBe("/api/projects/p1/status");
  expect(calls[0]?.init?.method).toBe("PATCH");
  expect(calls[0]?.init?.body).toBe(JSON.stringify({ status: "ready" }));
  expect(project.status).toBe("ready");
});

it("puts a project's name, version, caption and document, and nothing else", async () => {
  const calls = stubFetch(() => json({ project: storedProject({ version: 4 }) }));
  const saved = await persistProject(liveProject());
  expect(calls[0]?.url).toBe("/api/projects/p1");
  expect(calls[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    name: "Morning routine",
    version: 3,
    // The caption rides this same version guarded PUT rather than an endpoint
    // of its own, so it is on the body or it never reaches the server.
    description: "Five things to know first",
    hashtags: "#travel #summer",
    document: { ratio: { w: 9, h: 16 }, slides: [] },
  });
  expect(saved.version).toBe(4);
});

it("carries the server's copy of a slideshow out of a stale write", async () => {
  stubFetch(() =>
    json(
      {
        error: "This slideshow changed since you loaded it.",
        currentVersion: 9,
        project: storedProject({ version: 9, name: "Renamed elsewhere" }),
      },
      409,
    ),
  );
  const error = await persistProject(liveProject()).catch((thrown: unknown) => thrown);
  expect((error as ApiError).status).toBe(409);
  expect((error as ApiError).project?.version).toBe(9);
  expect((error as ApiError).project?.name).toBe("Renamed elsewhere");
});

it("sends a JSON content type only when it has a body", async () => {
  const calls = stubFetch(() => json({ project: storedProject() }));
  await api.getProject("p1");
  await api.createProject({ name: "Fresh" });
  expect(headerOf(calls[0], "Content-Type")).toBeNull();
  expect(headerOf(calls[1], "Content-Type")).toBe("application/json");
});

it("escapes an id that would otherwise reshape the path", async () => {
  const calls = stubFetch(() => json({ project: storedProject() }));
  await api.getProject("a b/c");
  expect(calls[0]?.url).toBe("/api/projects/a%20b%2Fc");
});
