import { z } from "zod";
import {
  composeDocument,
  toComposition,
  validateComposition,
} from "../../shared/compose/index.js";
import type { Composition, CompositionSource } from "../../shared/compose/index.js";
import type { Slide } from "../../shared/schema/index.js";
import { HttpError } from "../errors.js";
import type { AccountService } from "../services/accounts.js";
import type { ExportService, StoredRender } from "../services/exports.js";
import type { FontService } from "../services/fonts.js";
import type { LibraryService } from "../services/library.js";
import type {
  ProjectListOptions,
  ProjectService,
  StoredProject,
} from "../services/projects.js";
import { editUrl } from "../urls.js";

/** The things every tool reads, hung off the Fastify instance by Task 8. */
export interface ToolContext {
  library: LibraryService;
  projects: ProjectService;
  accounts: AccountService;
  fonts: FontService;
  exports: ExportService;
  baseUrl: () => string;
}

/**
 * The envelope all ten tools return. There are no output schemas and no
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

const listAccounts = defineTool({
  name: "list_accounts",
  title: "List accounts",
  description:
    "List every account: its id, name and defaults. Pass an id as accountId to create_slideshow, list_slideshows " +
    "or list_library. Every slideshow and library item belongs to exactly one account.",
  inputSchema: {},
  async handler(_args, { accounts }) {
    return json({ accounts: accounts.list() });
  },
});

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
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe("Limit to one account. Omit to search every account."),
  },
  async handler({ kind, query, sort, limit, accountId }, { library }) {
    const result = library.list({
      kind: kind || null,
      query: query || "",
      limit: limit || 50,
      sort: sort || "recent",
      ...(accountId === undefined ? {} : { accountId }),
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
        accountId: item.accountId,
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
    "hidden by default, because that work is already posted. Pass status to widen the list. Pass accountId to " +
    "see one account's slideshows only; omit it to see every account's.",
  inputSchema: {
    status: z
      .union([z.array(STATUS_SHAPE), z.literal("all")])
      .optional()
      .describe(
        'Statuses to include. Defaults to draft and ready. Pass "all" for everything.',
      ),
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe("Limit to one account. Omit to see every account."),
  },
  async handler({ status, accountId }, { projects, baseUrl }) {
    // `status: undefined` is not the same as an absent key under
    // exactOptionalPropertyTypes, and only the absent key takes the default.
    const options: ProjectListOptions = {
      ...(status === undefined ? {} : { status }),
      ...(accountId === undefined ? {} : { accountId }),
    };
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
    "Also returns the caption: `description` and `hashtags`, and the `accountId` it belongs to. " +
    "Layout is deliberately not exposed. Use the returned `version` when calling update_slideshow.",
  inputSchema: { id: z.string().describe("Slideshow id.") },
  async handler({ id }, { projects, baseUrl }) {
    const project = projects.require(id);
    return json({
      slideshow: {
        ...toComposition(asComposable(project)),
        accountId: project.accountId,
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
    "Draft a slideshow from library images and text, in one account. Each slide takes one background id, any " +
    "number of asset ids and any number of text lines. Write the caption too: a slideshow exists to be posted, " +
    "so `description` and `hashtags` are part of the draft rather than an afterthought. Do not attempt to set " +
    "positions, sizes or styling: the server lays everything out from the account's defaults and the human " +
    "adjusts it by hand afterwards. Call list_accounts first if you do not already know the accountId. Returns " +
    "the edit URL to hand back to the user.",
  inputSchema: {
    accountId: z
      .string()
      .describe("The account this slideshow belongs to. Call list_accounts to find one."),
    name: z.string().optional().describe("Slideshow name shown in the editor."),
    ratio: RATIO_SHAPE.optional().describe(
      "Aspect ratio as width and height. Defaults to the account's own ratio.",
    ),
    slides: z.array(SLIDE_SHAPE).min(1).describe("Slides in order."),
    description: DESCRIPTION_SHAPE.optional(),
    hashtags: HASHTAGS_SHAPE.optional(),
  },
  async handler(
    { accountId, name, ratio, slides, description, hashtags },
    { library, projects, accounts, fonts, baseUrl },
  ) {
    const account = accounts.get(accountId);
    if (account === null) throw new HttpError(400, `No account with id ${accountId}.`);
    const compositions = slides as Composition[];
    validateComposition(compositions, { accountId, lookupItem: (id) => library.get(id) });
    const document = composeDocument({
      ratio: ratio || account.defaults.ratio,
      slides: compositions,
      library,
      defaults: account.defaults,
      advanceRatioFor: (family) => fonts.advanceRatioFor(family),
    });
    const project = projects.create({
      name: name || "Agent slideshow",
      accountId,
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
    { library, projects, accounts, fonts, baseUrl },
  ) {
    const current = projects.require(id);
    const account = accounts.get(current.accountId);
    if (account === null) {
      throw new HttpError(400, `No account with id ${current.accountId}.`);
    }
    const compositions = slides as Composition[];
    validateComposition(compositions, {
      accountId: current.accountId,
      lookupItem: (itemId) => library.get(itemId),
    });
    const document = composeDocument({
      ratio: ratio || current.ratio,
      slides: compositions,
      library,
      defaults: account.defaults,
      previous: asComposable(current),
      advanceRatioFor: (family) => fonts.advanceRatioFor(family),
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

/**
 * Whether a scheduling tool on another machine could fetch a URL built from
 * this base. Loopback is the default base URL and is right for a laptop and
 * wrong here; `0.0.0.0` is the CLI's own wildcard bind (resolveAuthMode in
 * src/server/auth/mode.ts treats it as public) and just as unfetchable as a
 * literal address, so it belongs in this check even though it is not
 * loopback. Checked by hostname rather than by string, so a port or a scheme
 * cannot hide it.
 *
 * Not the same `isLoopback` src/server/auth/host.ts exports: that one reads a
 * request's remote address and never matches "localhost", which is exactly
 * the case this warning exists for.
 */
function isUnreachableBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

/** `/export/<token>/01.png`: the slide number a reader counts from, padded. */
function exportUrl(base: string, token: string, index: number): string {
  return `${base}/export/${token}/${String(index + 1).padStart(2, "0")}.png`;
}

function toExportSlide(base: string, token: string, render: StoredRender) {
  return {
    index: render.index + 1,
    url: exportUrl(base, token, render.index),
    mimeType: "image/png",
    width: render.width,
    height: render.height,
    bytes: render.bytes,
    // MediaStore names a file after the sha256 of its bytes, so the id is
    // already the checksum a caller verifies its upload against.
    sha256: render.mediaId,
  };
}

const exportSlideshow = defineTool({
  name: "export_slideshow",
  title: "Export a slideshow as image URLs",
  description:
    "Get one temporary public image URL per slide, in order, ready to hand to a scheduling tool such as " +
    "Metricool that downloads media by URL. The slideshow has to be `ready`, and the `version` you pass has to " +
    "be the one stored, so you can never publish a composition that has moved on. The URLs need no cookie and " +
    "no token, and they stop working after 45 minutes. Each slide also carries its width, height, byte count " +
    "and sha256, so you can check that what was downloaded is what was rendered. A `status` of `pending` means " +
    "the human has not opened the editor since this version became ready: the pixels are drawn in the browser, " +
    "so ask them to open the edit URL, then call again. Call revoke_export once the import is done.",
  inputSchema: {
    id: z.string().describe("Slideshow id."),
    version: z
      .number()
      .int()
      .describe(
        "Version read from get_slideshow. A version other than the stored one is refused.",
      ),
  },
  async handler({ id, version }, { projects, exports, baseUrl }) {
    const project = projects.require(id);
    if (project.status !== "ready") {
      throw new HttpError(
        409,
        `Only a ready slideshow can be exported, and this one is ${project.status}.`,
        { status: project.status, editUrl: editUrl(baseUrl(), project.id) },
      );
    }
    if (version !== project.version) {
      throw new HttpError(409, "That version is not the one stored.", {
        currentVersion: project.version,
      });
    }

    const base = baseUrl();
    const renders = exports.rendersFor(project.id, project.version);
    // Short as well as empty: an upload that failed halfway leaves a partial
    // set, and half a slideshow is not an export.
    if (renders.length < project.slides.length) {
      return json({
        slideshowId: project.id,
        version: project.version,
        status: "pending",
        rendered: renders.length,
        slideCount: project.slides.length,
        editUrl: editUrl(base, project.id),
        message:
          "The slides are drawn in the browser. Ask the human to open the edit URL with the slideshow " +
          "marked ready, then call export_slideshow again.",
      });
    }

    const { token, expiresAt } = exports.grant(project.id, project.version);
    return json({
      slideshowId: project.id,
      version: project.version,
      status: "ready",
      ratio: project.ratio,
      expiresAt: new Date(expiresAt).toISOString(),
      slides: renders.map((render) => toExportSlide(base, token, render)),
      // The export itself succeeded; only its reachability is in doubt, so this
      // is a field rather than a refusal.
      ...(isUnreachableBase(base)
        ? {
            warning:
              `These URLs point at ${base}, which only this machine can reach. Start the server with ` +
              "--public-url (or SLIDE_STUDIO_PUBLIC_URL) set to an address the scheduling tool can fetch.",
          }
        : {}),
    });
  },
});

const revokeExport = defineTool({
  name: "revoke_export",
  title: "Revoke a slideshow's export URLs",
  description:
    "Stop every temporary URL this slideshow has handed out, before they expire on their own. Call it once " +
    "the scheduling tool has finished downloading. The rendered images are kept, so a later export_slideshow " +
    "still works without the human re-rendering anything.",
  inputSchema: { id: z.string().describe("Slideshow id.") },
  async handler({ id }, { projects, exports }) {
    // require() rather than a bare delete, so revoking a typo is a 404 rather
    // than a cheerful "revoked 0".
    const project = projects.require(id);
    return json({ id: project.id, revoked: exports.revoke(project.id) });
  },
});

/** The ten tools, list_accounts first so an agent can see its brand before anything else. */
export const tools = {
  list_accounts: listAccounts,
  list_library: listLibrary,
  get_library_item: getLibraryItem,
  list_slideshows: listSlideshows,
  get_slideshow: getSlideshow,
  set_slideshow_status: setSlideshowStatus,
  create_slideshow: createSlideshow,
  update_slideshow: updateSlideshow,
  export_slideshow: exportSlideshow,
  revoke_export: revokeExport,
};
