import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { composeDocument, toComposition, validateComposition } from "./compose.mjs";
import { editUrl } from "./api.mjs";
import { HttpError } from "./library.mjs";

const SLIDE_SHAPE = z.object({
  name: z.string().optional().describe("Optional slide name."),
  background: z.string().describe("Library item id of a background. Required."),
  assets: z.array(z.string()).optional().describe("Library item ids of assets to place on the slide."),
  texts: z.array(z.string()).optional().describe("Lines of text to place on the slide, in reading order."),
});

const RATIO_SHAPE = z.object({ w: z.number().positive(), h: z.number().positive() });

export function createMcpServer({ library, projects, baseUrl }) {
  const server = new McpServer({ name: "slide-studio", version: "2.0.0" });

  server.registerTool("list_library", {
    title: "List library images",
    description:
      "List or search the background and asset libraries. Read each item's `description` (what the image shows) " +
      "and `usage` (when and how to use it) to choose well. Returns ids to pass to create_slideshow.",
    inputSchema: {
      kind: z.enum(["background", "asset"]).optional().describe("Limit to one library. Omit to search both."),
      query: z.string().optional().describe("Free text matched against name, description, usage and tags."),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ kind, query, limit }) => {
    const result = library.list({ kind: kind || null, query: query || "", limit: limit || 50 });
    return json({
      total: result.total,
      items: result.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        description: item.description,
        usage: item.usage,
        tags: item.tags,
        width: item.width,
        height: item.height,
      })),
    });
  });

  server.registerTool("get_library_item", {
    title: "Read one library image",
    description: "Read the full record for one library item, including its description and usage guidance.",
    inputSchema: { id: z.string().describe("Library item id.") },
  }, async ({ id }) => json({ item: library.require(id), usedBy: library.usedBy(id) }));

  server.registerTool("list_slideshows", {
    title: "List slideshows",
    description: "List every slideshow with its id, version, slide count and edit URL.",
    inputSchema: {},
  }, async () => json({
    slideshows: projects.list().map((summary) => ({ ...summary, editUrl: editUrl(baseUrl(), summary.id) })),
  }));

  server.registerTool("get_slideshow", {
    title: "Read a slideshow",
    description:
      "Read one slideshow as a composition: per slide, its background id, asset ids and texts. " +
      "Layout is deliberately not exposed. Use the returned `version` when calling update_slideshow.",
    inputSchema: { id: z.string().describe("Slideshow id.") },
  }, async ({ id }) => {
    const project = projects.require(id);
    return json({ slideshow: toComposition(project), editUrl: editUrl(baseUrl(), project.id) });
  });

  server.registerTool("create_slideshow", {
    title: "Create a slideshow",
    description:
      "Draft a slideshow from library images and text. Each slide takes one background id, any number of asset ids " +
      "and any number of text lines. Do not attempt to set positions, sizes or styling: the server lays everything " +
      "out and the human adjusts it by hand afterwards. Returns the edit URL to hand back to the user.",
    inputSchema: {
      name: z.string().optional().describe("Slideshow name shown in the editor."),
      ratio: RATIO_SHAPE.optional().describe("Aspect ratio as width and height, for example 9 by 16. Defaults to 9:16."),
      slides: z.array(SLIDE_SHAPE).min(1).describe("Slides in order."),
    },
  }, async ({ name, ratio, slides }) => {
    const document = composeDocument({ ratio, slides: validateComposition(slides), library });
    const project = projects.create({ name: name || "Agent slideshow", document });
    return json({
      id: project.id,
      version: project.version,
      slideCount: project.slides.length,
      editUrl: editUrl(baseUrl(), project.id),
    });
  });

  server.registerTool("update_slideshow", {
    title: "Update a slideshow",
    description:
      "Replace a slideshow's composition. Pass the `version` you read from get_slideshow: a stale version is " +
      "rejected so you cannot overwrite the human's work. Slides whose composition is unchanged keep the layout " +
      "the human adjusted, and geometry is preserved for any asset or text that is still present.",
    inputSchema: {
      id: z.string().describe("Slideshow id."),
      version: z.number().int().describe("Version read from get_slideshow."),
      name: z.string().optional(),
      ratio: RATIO_SHAPE.optional(),
      slides: z.array(SLIDE_SHAPE).min(1),
    },
  }, async ({ id, version, name, ratio, slides }) => {
    const current = projects.require(id);
    const document = composeDocument({
      ratio: ratio || current.ratio,
      slides: validateComposition(slides),
      library,
      previous: current,
    });
    const project = projects.save(id, { name: name ?? current.name, document, version });
    return json({
      id: project.id,
      version: project.version,
      slideCount: project.slides.length,
      editUrl: editUrl(baseUrl(), project.id),
    });
  });

  return server;
}

function json(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Stateless Streamable HTTP: every request builds its own server and transport,
 * so there are no sessions to track and any request is served independently.
 * A single McpServer cannot be reused, because connect() binds it to one
 * transport for its lifetime.
 */
export async function handleMcpRequest(buildServer, request, response, body) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}

export { HttpError };
