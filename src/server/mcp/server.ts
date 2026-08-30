import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { tools, type RawShape, type ToolContext, type ToolDefinition } from "./tools.js";

/**
 * Exactly the path Task 8's token guard tests, and exactly the one the old
 * server matched (server/main.mjs:86). A wildcard here would put `/mcp/stream`
 * outside that guard, where `path === "/mcp"` no longer holds and a remote
 * client with no token would be served.
 */
const MCP_PATH = "/mcp";

// The three methods Streamable HTTP defines. The transport answers anything
// else with a 405 of its own, so nothing else is registered here.
const MCP_METHODS = ["GET", "POST", "DELETE"] as const;

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "slide-studio", version: "2.0.0" });
  // Registered one by one rather than in a loop, because each tool's input shape
  // is its own type and a loop erases it.
  registerTool(server, tools.list_accounts, context);
  registerTool(server, tools.list_library, context);
  registerTool(server, tools.get_library_item, context);
  registerTool(server, tools.list_slideshows, context);
  registerTool(server, tools.get_slideshow, context);
  registerTool(server, tools.set_slideshow_status, context);
  registerTool(server, tools.create_slideshow, context);
  registerTool(server, tools.update_slideshow, context);
  registerTool(server, tools.export_slideshow, context);
  registerTool(server, tools.revoke_export, context);
  return server;
}

/**
 * The ten tools have ten different input shapes, and the SDK's callback type
 * is generic over the shape it was handed. This takes the erased shape, which
 * `ToolDefinition.handler` is a method rather than a property to allow.
 */
function registerTool(
  server: McpServer,
  tool: ToolDefinition<RawShape>,
  context: ToolContext,
): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
    (args) => tool.handler(args, context),
  );
}

/**
 * Mounts the MCP endpoint on the Fastify instance the CLI built. The transport
 * owns the raw request and reply streams, so the route hijacks the reply and
 * Fastify sends nothing itself.
 */
export async function registerMcp(app: FastifyInstance): Promise<void> {
  const context: ToolContext = {
    library: app.library,
    projects: app.projects,
    accounts: app.accounts,
    fonts: app.fonts,
    exports: app.exports,
    baseUrl: app.baseUrl,
  };
  await app.register((scope, _options, done) => {
    scope.route({
      method: [...MCP_METHODS],
      url: MCP_PATH,
      handler: handleMcpRequest(context),
    });
    done();
  });
}

/**
 * Stateless Streamable HTTP: every request builds its own server and transport,
 * so there are no sessions to track and any request is served independently.
 * A single McpServer cannot be reused, because connect() binds it to one
 * transport for its lifetime (server/mcp.mjs:164-169).
 */
function handleMcpRequest(context: ToolContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const server = createMcpServer(context);
    // Stateless: an absent sessionIdGenerator turns session tracking off. The
    // SDK's own example writes it as an explicit `undefined`, which
    // exactOptionalPropertyTypes refuses, and both reach the same branch.
    const transport = new StreamableHTTPServerTransport({});
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's own transport does not satisfy its Transport interface under
      // exactOptionalPropertyTypes: the class types `onclose` as
      // `(() => void) | undefined`, the interface declares it optional and never
      // undefined. The cast restates what the SDK already guarantees.
      await server.connect(transport as Transport);
      // The old server read a body for POST only (server/main.mjs:87), and the
      // transport reads the stream itself when none is passed.
      await transport.handleRequest(
        request.raw,
        reply.raw,
        request.method === "POST" ? request.body : undefined,
      );
    } catch (error) {
      console.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  };
}
