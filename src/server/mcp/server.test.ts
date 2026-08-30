import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { addItem, makeTempApp } from "../testing.js";

const REMOTE = "192.168.1.20";

let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  // buildApp mounts /mcp itself (src/server/app.ts), so nothing is registered here.
  app = await makeTempApp();
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await app.close();
});

/** A client speaking the real transport, so the route is proved end to end. */
async function connect(): Promise<Client> {
  const client = new Client({ name: "slide-studio-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  // The SDK's own transport does not satisfy its Transport interface under
  // exactOptionalPropertyTypes, the same mismatch server.ts documents.
  await client.connect(transport as Transport);
  return client;
}

/**
 * `callTool` answers with a union: the content blocks, or the legacy
 * `toolResult`. Every tool here returns one text block, so this narrows to it.
 */
type ToolOutcome = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolOutcome): string {
  const blocks = "content" in result ? result.content : undefined;
  const first = Array.isArray(blocks) ? blocks[0] : undefined;
  expect(first?.type).toBe("text");
  return first?.type === "text" ? first.text : "";
}

it("serves the ten tools over the transport", async () => {
  const client = await connect();
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_accounts",
      "list_library",
      "get_library_item",
      "list_slideshows",
      "get_slideshow",
      "set_slideshow_status",
      "create_slideshow",
      "update_slideshow",
      "export_slideshow",
      "revoke_export",
    ]);
    // The SDK builds the JSON schema from the raw zod shape it was handed.
    expect(listed.tools[1]?.inputSchema.properties).toMatchObject({
      kind: { description: "Limit to one library. Omit to search both." },
    });
  } finally {
    await client.close();
  }
});

it("creates a slideshow through a real tool call", async () => {
  const item = await addItem(app.library, "background", "Sunset");
  const client = await connect();
  try {
    const created = await client.callTool({
      name: "create_slideshow",
      arguments: {
        accountId: "default",
        name: "Launch",
        slides: [{ background: item.id, texts: ["Hello"] }],
      },
    });
    const body = JSON.parse(textOf(created)) as { id: string; editUrl: string };
    expect(body.editUrl).toBe(`http://127.0.0.1:4173/projects/${body.id}`);
    expect(app.projects.require(body.id).name).toBe("Launch");
  } finally {
    await client.close();
  }
});

it("reports a bad library id as a tool error rather than a crash", async () => {
  const item = await addItem(app.library, "asset", "Arrow");
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "create_slideshow",
      arguments: { accountId: "default", slides: [{ background: item.id }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is an asset, expected a background/);
  } finally {
    await client.close();
  }
});

// No account has "" as its id. An empty accountId used to be indistinguishable
// from an omitted one (both fell through the same `|| null`), so it silently
// widened these two filters to every account instead of narrowing to none.
it("rejects an empty accountId on list_library rather than searching every account", async () => {
  await addItem(app.library, "background", "Sunset");
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "list_library",
      arguments: { accountId: "" },
    });
    expect(result.isError).toBe(true);
  } finally {
    await client.close();
  }
});

it("rejects an empty accountId on list_slideshows rather than listing every account", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "list_slideshows",
      arguments: { accountId: "" },
    });
    expect(result.isError).toBe(true);
  } finally {
    await client.close();
  }
});

const STILL_OPEN = "kept its response open";

/**
 * `app.inject` never resolves against the SSE stream a transport opens, so a
 * subpath that reached the MCP server would hang this test instead of failing
 * it. Racing a timer turns that hang into a failure that names the hole.
 */
async function injectOrHang(
  options: InjectOptions,
): Promise<LightMyRequestResponse | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(STILL_OPEN), 500);
  });
  try {
    return await Promise.race([app.inject(options), hung]);
  } finally {
    clearTimeout(timer);
  }
}

it("puts no MCP endpoint on a subpath of /mcp", async () => {
  // This is what the exact registration buys. Mounted as /mcp/* these would be
  // the MCP server, and the guard's exact `path === "/mcp"` would not cover
  // them, so an untokened remote client would be talking to it.
  for (const url of ["/mcp/", "/mcp/stream", "/mcp/anything"]) {
    const response = await injectOrHang({
      method: "GET",
      url,
      remoteAddress: REMOTE,
      headers: { accept: "application/json, text/event-stream" },
    });
    if (typeof response === "string") {
      throw new Error(
        `GET ${url} ${response}: an MCP transport is mounted on a subpath of /mcp, ` +
          `where the token guard's exact \`path === "/mcp"\` does not reach it.`,
      );
    }
    // Whatever answers is the public client shell or a 404, never the transport.
    expect([200, 404], url).toContain(response.statusCode);
    expect(response.body, url).not.toContain("jsonrpc");
    expect(response.body, url).not.toContain("list_library");
    expect(app.findRoute({ method: "GET", url }), url).toBeNull();
  }
});

it("answers the token-bearing remote client on the exact path", async () => {
  // app.token is the legacy shared secret, no longer a credential (Task 9). A
  // real agent token is what the guard actually checks.
  const { secret } = app.tokens.create("agent");
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: REMOTE,
    headers: {
      authorization: `Bearer ${secret}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  expect(response.statusCode).toBe(200);
});
