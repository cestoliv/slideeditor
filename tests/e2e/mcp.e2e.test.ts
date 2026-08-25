import { expect, it } from "vitest";

// The browser talks to the same origin Vitest serves the page from, and that
// origin forwards /mcp to the real server (vitest.config.ts). These prove the
// forward reaches an MCP endpoint, which it could not before buildApp mounted
// one: the proxy was pointing at a path the end-to-end server did not serve.
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
}

it("handshakes with the MCP endpoint through the proxy", async () => {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "slide-studio-e2e", version: "0.0.0" },
    }),
  });
  expect(response.status).toBe(200);
  // The body is what makes this a proof: Vitest's own page server answers an
  // unforwarded path with index.html and a 200.
  const body = await response.text();
  expect(body).toContain('"serverInfo"');
  expect(body).toContain('"name":"slide-studio"');
});

it("lists the seven tools through the proxy", async () => {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: rpc("tools/list"),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  for (const tool of [
    "list_library",
    "get_library_item",
    "list_slideshows",
    "get_slideshow",
    "set_slideshow_status",
    "create_slideshow",
    "update_slideshow",
  ]) {
    expect(body, tool).toContain(`"${tool}"`);
  }
});

it("puts no MCP endpoint on a subpath of /mcp", async () => {
  for (const path of ["/mcp/", "/mcp/stream"]) {
    const response = await fetch(path, {
      method: "POST",
      headers: MCP_HEADERS,
      body: rpc("tools/list"),
    });
    const body = await response.text();
    expect(body, path).not.toContain("list_library");
    expect(body, path).not.toContain('"serverInfo"');
  }
});
