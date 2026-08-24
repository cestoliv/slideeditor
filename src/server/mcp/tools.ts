import { z } from "zod";
import {
  composeDocument,
  toComposition,
  validateComposition,
} from "../../shared/compose/index.js";
import type { CompositionSource } from "../../shared/compose/index.js";
import type { Slide } from "../../shared/schema/index.js";
import type { LibraryService } from "../services/library.js";
import type {
  ProjectListOptions,
  ProjectService,
  StoredProject,
} from "../services/projects.js";
import { editUrl } from "../urls.js";

/** The three things every tool reads, hung off the Fastify instance by Task 8. */
export interface ToolContext {
  library: LibraryService;
  projects: ProjectService;
  baseUrl: () => string;
}

/**
 * The envelope all seven tools return. There are no output schemas and no
 * structured content, only one JSON text block (server/mcp.mjs:160-162).
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
};

/**
 * A raw shape, the way the SDK wants `inputSchema`: a plain object of zod
 * validators rather than a z.object(...). The SDK wraps it itself.
 */
export type RawShape = Record<string, z.ZodType>;

/**
 * What a handler receives. The SDK wraps the raw shape in a z.object before it
 * parses, so the same wrap is what gives an optional field an optional key here
 * rather than a required one holding `undefined`.
 */
export type ShapeOutput<Shape extends RawShape> = z.output<z.ZodObject<Shape>>;

/**
 * A tool as a value rather than a call on a server. The handler takes its
 * context as an argument, so a test calls it directly instead of standing a
 * transport up around it. Every handler is async, so a service that throws
 * reaches the caller as a rejection.
 */
export interface ToolDefinition<Shape extends RawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  handler(args: ShapeOutput<Shape>, context: ToolContext): Promise<ToolResult>;
}

function defineTool<Shape extends RawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}

function json(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * The stored document keeps a human's slides verbatim, so the service types them
 * `unknown[]`. The compose engine reads every field defensively and the old MCP
 * server handed it these same rows, so the document crosses unparsed.
 */
function asComposable(project: StoredProject): CompositionSource {
  return { ...project, slides: project.slides as Slide[] };
}

const SLIDE_SHAPE = z.object({
  name: z.string().optional().describe("Optional slide name."),
  background: z.string().describe("Library item id of a background. Required."),
  assets: z
    .array(z.string())
    .optional()
    .describe("Library item ids of assets to place on the slide."),
  texts: z
    .array(z.string())
    .optional()
    .describe("Lines of text to place on the slide, in reading order."),
});

const RATIO_SHAPE = z.object({ w: z.number().positive(), h: z.number().positive() });
const STATUS_SHAPE = z.enum(["draft", "ready", "published"]);

const DESCRIPTION_SHAPE = z
  .string()
  .describe(
    "The caption to post the slideshow with, up to 2200 characters. The human edits it in the editor and copies it into TikTok or Instagram.",
  );

/*
 * A list or a line, because an agent thinks in tags and a person types a
 * string. Whichever arrives, `#travel #summer` is what comes back.
 */
const HASHTAGS_SHAPE = z
  .union([z.array(z.string()), z.string()])
  .describe(
    'Hashtags for the post, either as a list (["travel", "summer"]) or as one string ("#travel #summer"). The leading # is optional going in and always present coming back. At most 30, and a tag repeated in any casing is kept once.',
  );

const listLibrary = defineTool({
  name: "list_library",
  title: "List library images",
  description:
    "List or search the background and asset libraries. Read each item's `description` (what the image shows) " +
    "and `usage` (when and how to use it) to choose well. Each item also carries `stats`, a record of how often " +
    "it has been used before. When several items fit the slide equally well, pick the one with the lower " +
    "`stats.timesUsed`, or the older `stats.lastUsedAt`, so slideshows do not all end up looking the same. " +
    "Sort by `least-used` to see the neglected ones first. Returns ids to pass to create_slideshow.",
  inputSchema: {
    kind: z
      .enum(["background", "asset"])
      .optional()
      .describe("Limit to one library. Omit to search both."),
    query: z
      .string()
      .optional()
      .describe("Free text matched against name, description, usage and tags."),
    sort: z
      .enum(["recent", "least-used", "most-used"])
      .optional()
      .describe(
        "Order of results. Use `least-used` to favour items you have not used before. Defaults to relevance when searching, newest otherwise.",
      ),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async handler({ kind, query, sort, limit }, { library }) {
    const result = library.list({
      kind: kind || null,
      query: query || "",
      limit: limit || 50,
      sort: sort || "recent",
    });
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
        stats: item.stats,
      })),
    });
  },
});

const getLibraryItem = defineTool({
  name: "get_library_item",
  title: "Read one library image",
  description:
    "Read the full record for one library item, including its description and usage guidance.",
  inputSchema: { id: z.string().describe("Library item id.") },
  async handler({ id }, { library }) {
    return json({ item: library.require(id), usedBy: library.usedBy(id) });
  },
});

const listSlideshows = defineTool({
  name: "list_slideshows",
  title: "List slideshows",
  description:
    "List slideshows with their id, version, status, caption, slide count and edit URL. Published slideshows are " +
    "hidden by default, because that work is already posted. Pass status to widen the list.",
  inputSchema: {
    status: z
      .union([z.array(STATUS_SHAPE), z.literal("all")])
      .optional()
      .describe(
        'Statuses to include. Defaults to draft and ready. Pass "all" for everything.',
      ),
  },
  async handler({ status }, { projects, baseUrl }) {
    // `status: undefined` is not the same as an absent key under
    // exactOptionalPropertyTypes, and only the absent key takes the default.
    const options: ProjectListOptions = status === undefined ? {} : { status };
    return json({
      slideshows: projects
        .list(options)
        .map((summary) => ({ ...summary, editUrl: editUrl(baseUrl(), summary.id) })),
    });
  },
});

const getSlideshow = defineTool({
  name: "get_slideshow",
  title: "Read a slideshow",
  description:
    "Read one slideshow as a composition: per slide, its background id, asset ids and texts. " +
    "Also returns the caption: `description` and `hashtags`. " +
    "Layout is deliberately not exposed. Use the returned `version` when calling update_slideshow.",
  inputSchema: { id: z.string().describe("Slideshow id.") },
  async handler({ id }, { projects, baseUrl }) {
    const project = projects.require(id);
    return json({
      slideshow: {
        ...toComposition(asComposable(project)),
        status: project.status,
        description: project.description,
        hashtags: project.hashtags,
      },
      editUrl: editUrl(baseUrl(), project.id),
    });
  },
});

const setSlideshowStatus = defineTool({
  name: "set_slideshow_status",
  title: "Set a slideshow's status",
  description:
    "Move a slideshow between draft, ready and published. `draft` is work in progress and is where every new " +
    "slideshow starts. `ready` means the human has finished adjusting it. `published` means it has been posted, " +
    "and hides it from the default list. Status is only a label: it never locks editing, and changing it does " +
    "not bump the version.",
  inputSchema: {
    id: z.string().describe("Slideshow id."),
    status: STATUS_SHAPE.describe("The status to set."),
  },
  async handler({ id, status }, { projects, baseUrl }) {
    const project = projects.setStatus(id, status);
    return json({
      id: project.id,
      status: project.status,
      editUrl: editUrl(baseUrl(), project.id),
    });
  },
});

const createSlideshow = defineTool({
  name: "create_slideshow",
  title: "Create a slideshow",
  description:
    "Draft a slideshow from library images and text. Each slide takes one background id, any number of asset ids " +
    "and any number of text lines. Write the caption too: a slideshow exists to be posted, so `description` and " +
    "`hashtags` are part of the draft rather than an afterthought. Do not attempt to set positions, sizes or " +
    "styling: the server lays everything out and the human adjusts it by hand afterwards. Returns the edit URL to " +
    "hand back to the user.",
  inputSchema: {
    name: z.string().optional().describe("Slideshow name shown in the editor."),
    ratio: RATIO_SHAPE.optional().describe(
      "Aspect ratio as width and height, for example 9 by 16. Defaults to 9:16.",
    ),
    slides: z.array(SLIDE_SHAPE).min(1).describe("Slides in order."),
    description: DESCRIPTION_SHAPE.optional(),
    hashtags: HASHTAGS_SHAPE.optional(),
  },
  async handler(
    { name, ratio, slides, description, hashtags },
    { library, projects, baseUrl },
  ) {
    const document = composeDocument({
      ratio,
      slides: validateComposition(slides),
      library,
    });
    const project = projects.create({
      name: name || "Agent slideshow",
      document,
      description,
      hashtags,
    });
    return json({
      id: project.id,
      version: project.version,
      slideCount: project.slides.length,
      // Echoed so the caller reads the caption as it was stored, without a
      // second call to find out what its hashtags became.
      description: project.description,
      hashtags: project.hashtags,
      editUrl: editUrl(baseUrl(), project.id),
    });
  },
});

const updateSlideshow = defineTool({
  name: "update_slideshow",
  title: "Update a slideshow",
  description:
    "Replace a slideshow's composition. Pass the `version` you read from get_slideshow: a stale version is " +
    "rejected so you cannot overwrite the human's work. Slides whose composition is unchanged keep the layout " +
    "the human adjusted, and geometry is preserved for any asset or text that is still present. A caption field " +
    "you leave out keeps what is stored, so editing the slides never wipes a caption the human has been working " +
    "on. Send an empty string to clear one on purpose.",
  inputSchema: {
    id: z.string().describe("Slideshow id."),
    version: z.number().int().describe("Version read from get_slideshow."),
    name: z.string().optional(),
    ratio: RATIO_SHAPE.optional(),
    slides: z.array(SLIDE_SHAPE).min(1),
    description: DESCRIPTION_SHAPE.optional(),
    hashtags: HASHTAGS_SHAPE.optional(),
  },
  async handler(
    { id, version, name, ratio, slides, description, hashtags },
    { library, projects, baseUrl },
  ) {
    const current = projects.require(id);
    const document = composeDocument({
      ratio: ratio || current.ratio,
      slides: validateComposition(slides),
      library,
      previous: asComposable(current),
    });
    const project = projects.save(id, {
      name: name ?? current.name,
      document,
      version,
      description,
      hashtags,
    });
    return json({
      id: project.id,
      version: project.version,
      slideCount: project.slides.length,
      description: project.description,
      hashtags: project.hashtags,
      editUrl: editUrl(baseUrl(), project.id),
    });
  },
});

/** The seven tools, in the order server/mcp.mjs registered them. */
export const tools = {
  list_library: listLibrary,
  get_library_item: getLibraryItem,
  list_slideshows: listSlideshows,
  get_slideshow: getSlideshow,
  set_slideshow_status: setSlideshowStatus,
  create_slideshow: createSlideshow,
  update_slideshow: updateSlideshow,
};
