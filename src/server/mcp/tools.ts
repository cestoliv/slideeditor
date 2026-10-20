import { createHash } from "node:crypto";
import { z } from "zod";
import {
  composeDocument,
  toComposition,
  validateComposition,
} from "../../shared/compose/index.js";
import type { Composition, CompositionSource } from "../../shared/compose/index.js";
import {
  styledTextSchema,
  type LibraryItem,
  type Slide,
} from "../../shared/schema/index.js";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "../../shared/text/index.js";
import { HttpError } from "../errors.js";
import type { AccountService } from "../services/accounts.js";
import { convertRender, extensionFor, mimeTypeFor } from "../services/convert.js";
import {
  DEFAULT_QUALITY,
  type ExportFormat,
  type ExportService,
  type StoredRender,
} from "../services/exports.js";
import type { FontService } from "../services/fonts.js";
import { fetchImage, type FetchedImage } from "../services/fetchImage.js";
import type { LibraryService } from "../services/library.js";
import { decodeImage, type MediaStore } from "../services/media.js";
import { renderPreview } from "../services/preview.js";
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
  // export_slideshow converts a render before it grants a URL, which means
  // reading the PNG bytes and writing the converted ones.
  media: MediaStore;
  baseUrl: () => string;
  // Replaced by a test that serves its image from loopback, which the real
  // fetcher refuses.
  fetchImage?: (url: string) => Promise<FetchedImage>;
}

/**
 * The envelope every tool returns. There are no output schemas and no
 * structured content (server/mcp.mjs:160-162). Every tool answers with one JSON
 * text block, and preview_slideshow puts its images, base64, ahead of it.
 */
export type ToolResult = {
  content: (
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  )[];
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
    .array(z.union([z.string(), styledTextSchema]))
    .optional()
    .describe(
      "Lines of text to place on the slide, in reading order. A string takes the account's text style. " +
        `An object styles that one line: \`size\` (${String(FONT_SIZE_MIN)}-${String(FONT_SIZE_MAX)}), ` +
        "`style` (plain, outline or boxed), `color`, `background`, `weight`, `italic` and `align`. " +
        "Use it for a hook set larger than the rest or a key word in another colour. On a new line, a field " +
        "you leave out takes the account's default. On a line already on the slide, it keeps its current " +
        "value. The server still places every line.",
    ),
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
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Items to skip, for paging. Keep calling with offset + limit until it reaches `total`.",
      ),
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe("Limit to one account. Omit to search every account."),
  },
  async handler({ kind, query, sort, limit, offset, accountId }, { library, baseUrl }) {
    const result = library.list({
      kind: kind || null,
      query: query || "",
      limit: limit || 50,
      offset: offset ?? 0,
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
        url: absoluteUrl(baseUrl(), item.url),
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
    "Layout is deliberately not exposed. Use the returned `version` when calling update_slideshow. " +
    "`layoutChanged` counts the slides the human changed by hand since the slideshow was created or " +
    "duplicated, or is null when no agent composed it.",
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
        layoutChanged: projects.layoutChanged(project.id),
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
    "positions: the server lays everything out from the account's defaults and the human adjusts it by hand " +
    "afterwards. It keeps texts and assets clear of the TikTok buttons and caption, puts a lone asset top " +
    "left, and stacks the texts below it: high on the first slide, mid-height in the middle, lower on the " +
    "last. A text line can carry its own size, colour and style when one line has to stand out. Call list_accounts first if you do not already know the accountId. Returns " +
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
      composed: true,
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

const duplicateSlideshow = defineTool({
  name: "duplicate_slideshow",
  title: "Duplicate a slideshow",
  description:
    "Copy a slideshow into a new draft in the same account, layout and all. Use it to start from a template the " +
    "human has already adjusted: duplicate it, then change the texts with update_slideshow. Slides and lines you " +
    "leave unchanged keep the human's layout. The copy keeps the caption unless you pass a new one. Returns the " +
    "new id and version.",
  inputSchema: {
    id: z.string().describe("Id of the slideshow to copy."),
    name: z
      .string()
      .optional()
      .describe('Name of the copy. Defaults to "<name> (copy)".'),
    description: DESCRIPTION_SHAPE.optional(),
    hashtags: HASHTAGS_SHAPE.optional(),
  },
  async handler({ id, name, description, hashtags }, { projects, baseUrl }) {
    const source = projects.require(id);
    // Same account only: a library item belongs to one account, and create()
    // refuses a document that references another account's images.
    const project = projects.create({
      name: name ?? `${source.name} (copy)`,
      accountId: source.accountId,
      document: { ratio: source.ratio, slides: source.slides },
      description: description ?? source.description,
      hashtags: hashtags ?? source.hashtags,
      composed: true,
    });
    return json({
      id: project.id,
      version: project.version,
      status: project.status,
      slideCount: project.slides.length,
      description: project.description,
      hashtags: project.hashtags,
      editUrl: editUrl(baseUrl(), project.id),
    });
  },
});

const deleteSlideshow = defineTool({
  name: "delete_slideshow",
  title: "Delete a draft slideshow",
  description:
    "Delete a slideshow for good. Only a draft can be deleted: a ready or published slideshow is refused, " +
    "because the human has signed it off. To delete one of those, ask the human to move it back to draft.",
  inputSchema: { id: z.string().describe("Slideshow id.") },
  async handler({ id }, { projects }) {
    const project = projects.require(id);
    if (project.status !== "draft") {
      throw new HttpError(
        409,
        `Only a draft slideshow can be deleted, and this one is ${project.status}.`,
        { status: project.status },
      );
    }
    return json(projects.remove(id));
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

/** `/export/<token>/01.jpg`: the slide number a reader counts from, padded. */
function exportUrl(
  base: string,
  token: string,
  index: number,
  format: ExportFormat,
): string {
  const name = String(index + 1).padStart(2, "0");
  return `${base}/export/${token}/${name}.${extensionFor(format)}`;
}

function toExportSlide(
  base: string,
  token: string,
  slide: StoredRender,
  format: ExportFormat,
) {
  return {
    index: slide.index + 1,
    url: exportUrl(base, token, slide.index, format),
    mimeType: mimeTypeFor(format),
    width: slide.width,
    height: slide.height,
    bytes: slide.bytes,
    // MediaStore names a file after the sha256 of its bytes, so the id is
    // already the checksum a caller verifies its upload against.
    sha256: slide.mediaId,
  };
}

/**
 * Every slide, converted to one format at one quality.
 *
 * A slide already filed at this key is read back rather than re-encoded, which
 * is what makes a second export of the same settings free. The whole set
 * finishes before the caller mints a grant, so a conversion that throws leaves
 * no token serving half a slideshow.
 */
async function convertedSlides(
  context: ToolContext,
  slideshowId: string,
  version: number,
  renders: StoredRender[],
  format: "jpeg" | "webp",
  quality: number,
): Promise<StoredRender[]> {
  const stored = new Map(
    context.exports
      .variantsFor(slideshowId, version, format, quality)
      .map((variant) => [variant.index, variant]),
  );
  const slides: StoredRender[] = [];
  for (const render of renders) {
    const existing = stored.get(render.index);
    if (existing !== undefined) {
      slides.push(existing);
      continue;
    }
    const png = await context.media.read(render.mediaId, "png");
    const converted = await convertRender(png, format, quality);
    const mediaId = await context.media.put(converted.bytes, extensionFor(format));
    const variant = {
      index: render.index,
      mediaId,
      width: converted.width,
      height: converted.height,
      bytes: converted.bytes.byteLength,
    };
    context.exports.putVariant(
      slideshowId,
      version,
      render.index,
      format,
      quality,
      variant,
    );
    slides.push(variant);
  }
  return slides;
}

const exportSlideshow = defineTool({
  name: "export_slideshow",
  title: "Export a slideshow as image URLs",
  description:
    "Get one temporary public image URL per slide, in order, ready to hand to a scheduling tool such as " +
    "Metricool that downloads media by URL. The slideshow has to be `ready`, and the `version` you pass has to " +
    "be the one stored, so you can never publish a composition that has moved on. The URLs need no cookie and " +
    "no token, and they stop working after 45 minutes. Slides come back as JPEG at quality 92 unless you ask " +
    "for `png` or `webp`, always over an opaque white background, so a transparent pixel never reaches a feed " +
    "composited against something else. `quality` runs from 1 to 100 and is refused with `png`, which is " +
    "lossless. Each slide also carries its width, height, byte count and sha256, so you can check that what " +
    "was downloaded is what was rendered. A `status` of `pending` means the human has not opened the editor " +
    "since this version became ready: the pixels are drawn in the browser, so ask them to open the edit URL, " +
    "then call again. Call revoke_export once the import is done.",
  inputSchema: {
    id: z.string().describe("Slideshow id."),
    version: z
      .number()
      .int()
      .describe(
        "Version read from get_slideshow. A version other than the stored one is refused.",
      ),
    // Optional rather than defaulted: a zod default is indistinguishable from a
    // value a caller typed, and refusing `quality` on png needs to tell those
    // apart.
    format: z
      .enum(["png", "jpeg", "webp"])
      .optional()
      .describe("Image format. Defaults to jpeg, which is what a feed wants."),
    quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Encoder quality from 1 to 100, for jpeg and webp. Defaults to 92."),
  },
  async handler({ id, version, format, quality }, context) {
    const { projects, exports, baseUrl } = context;
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
    // A caller that thinks it capped a file size is worse off than one that
    // gets an error, so this is a refusal rather than a quietly ignored field.
    if (format === "png" && quality !== undefined) {
      throw new HttpError(
        400,
        "PNG is lossless and ignores `quality`. Drop `quality`, or ask for jpeg or webp.",
      );
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

    const chosen = format ?? "jpeg";
    // PNG stores 100 rather than the caller's number, because there is no
    // caller's number to store: the branch above refused one.
    const chosenQuality = chosen === "png" ? 100 : (quality ?? DEFAULT_QUALITY);
    const slides =
      chosen === "png"
        ? renders
        : await convertedSlides(
            context,
            project.id,
            project.version,
            renders,
            chosen,
            chosenQuality,
          );

    const { token, expiresAt } = exports.grant(project.id, project.version, {
      format: chosen,
      quality: chosenQuality,
    });
    return json({
      slideshowId: project.id,
      version: project.version,
      status: "ready",
      format: chosen,
      quality: chosenQuality,
      ratio: project.ratio,
      expiresAt: new Date(expiresAt).toISOString(),
      slides: slides.map((slide) => toExportSlide(base, token, slide, chosen)),
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
    "the scheduling tool has finished downloading. It revokes PNG, JPEG and WebP URLs alike. The rendered " +
    "images are kept, so a later export_slideshow still works without the human re-rendering anything.",
  inputSchema: { id: z.string().describe("Slideshow id.") },
  async handler({ id }, { projects, exports }) {
    // require() rather than a bare delete, so revoking a typo is a 404 rather
    // than a cheerful "revoked 0".
    const project = projects.require(id);
    return json({ id: project.id, revoked: exports.revoke(project.id) });
  },
});

/*
 * Account and library writes. Kept together, apart from the tools above, so
 * a change to either set stays out of the other's way.
 */

/** A media path the way get_library_item stores it, made fetchable with the caller's token. */
function absoluteUrl(base: string, path: string): string {
  return `${base}${path}`;
}

function withAbsoluteUrl(item: LibraryItem, base: string): LibraryItem {
  return { ...item, url: absoluteUrl(base, item.url) };
}

/*
 * Every field optional, because the service merges what is sent over what is
 * there. The service validates the values too, so the shape only describes
 * them to the agent.
 */
const ACCOUNT_DEFAULTS_SHAPE = z
  .object({
    ratio: RATIO_SHAPE.optional().describe(
      "Aspect ratio of new slideshows, such as {w: 3, h: 4}.",
    ),
    text: z
      .object({
        fontFamily: z.string().describe("A font this installation knows."),
        size: z.number().describe("Text size, from 20 to 180."),
        style: z.enum(["plain", "outline", "boxed"]),
        color: z.string().describe("Hex colour, such as #111111."),
        background: z.string().describe("Hex colour of the box behind boxed text."),
        backgroundShape: z.enum(["lines", "full"]),
        align: z.enum(["left", "center", "right"]),
        maxWidth: z.number().describe("Text width as a fraction of the slide, 0 to 1."),
        weight: z.number().nullable(),
        italic: z.boolean(),
        underline: z.boolean(),
        strikethrough: z.boolean(),
      })
      .partial()
      .optional(),
  })
  .describe(
    "The look new slideshows start from. A field you leave out keeps its current value, or the built-in default on a new account.",
  );

const TAGS_SHAPE = z
  .union([z.array(z.string()), z.string()])
  .describe(
    'Tags, as a list (["hook", "gym"]) or one comma-separated string. Stored lowercase, each once.',
  );

const createAccount = defineTool({
  name: "create_account",
  title: "Create an account",
  description:
    "Create an account: one brand, with its own library and slideshows. Partial `defaults` inherit the " +
    "built-in defaults. Returns the account, whose id you pass as accountId to the other tools.",
  inputSchema: {
    name: z.string().describe("Account name, as shown in the editor."),
    defaults: ACCOUNT_DEFAULTS_SHAPE.optional(),
  },
  async handler({ name, defaults }, { accounts }) {
    return json({ account: accounts.create({ name, defaults }) });
  },
});

const updateAccount = defineTool({
  name: "update_account",
  title: "Update an account",
  description:
    "Rename an account or change its defaults. Fields you leave out keep their value. New defaults apply " +
    "to slideshows created afterwards only: an existing slideshow keeps its ratio and layout.",
  inputSchema: {
    id: z.string().describe("Account id."),
    name: z.string().optional(),
    defaults: ACCOUNT_DEFAULTS_SHAPE.optional(),
  },
  async handler({ id, name, defaults }, { accounts }) {
    return json({ account: accounts.update(id, { name, defaults }) });
  },
});

const addLibraryItem = defineTool({
  name: "add_library_item",
  title: "Add a library image",
  description:
    "Add one image to an account's library, from a public `url` or from base64 `data`. Pass exactly one. " +
    "PNG, JPEG, WebP and GIF up to 25 MB are accepted. A URL has 10 seconds to download and " +
    "must not point at a private address. Write `description` (what the image shows) and `usage` (when " +
    "to use it): list_library is how you choose images later, and it reads only those. If the account " +
    "already holds the same image as the same kind, nothing is added: the existing item comes back with `duplicateOf`, so " +
    "an import can be run again safely.",
  inputSchema: {
    accountId: z.string().describe("The account the image belongs to."),
    kind: z
      .enum(["background", "asset"])
      .describe("`background` fills a slide. `asset` is placed on top of one."),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).describe("What the image shows."),
    usage: z.string().trim().min(1).describe("When and how to use it on a slide."),
    tags: TAGS_SHAPE.optional(),
    url: z.string().optional().describe("Public http or https URL of the image."),
    data: z.string().optional().describe("The image as base64, or as a data: URI."),
    contentType: z
      .string()
      .optional()
      .describe(
        "MIME type of `data`, such as image/png. Read from a data: URI if omitted.",
      ),
  },
  async handler(args, context) {
    const { library, baseUrl } = context;
    const { url, data } = args;
    if ((url === undefined) === (data === undefined)) {
      throw new HttpError(400, "Pass exactly one of `url` or `data`.");
    }
    const image =
      url === undefined
        ? {
            bytes: decodeImage(data),
            contentType: args.contentType ?? /^data:([^;,]+)/.exec(data ?? "")?.[1] ?? "",
          }
        : await (context.fetchImage ?? fetchImage)(url);
    const mediaId = createHash("sha256").update(image.bytes).digest("hex");
    const existing = library.findByMedia(args.accountId, args.kind, mediaId);
    if (existing) {
      return json({
        item: withAbsoluteUrl(existing, baseUrl()),
        duplicateOf: { id: existing.id, name: existing.name },
      });
    }
    const item = await library.create({
      kind: args.kind,
      name: args.name,
      description: args.description,
      usage: args.usage,
      tags: args.tags,
      contentType: image.contentType,
      bytes: image.bytes,
      accountId: args.accountId,
    });
    return json({ item: withAbsoluteUrl(item, baseUrl()) });
  },
});

const updateLibraryItem = defineTool({
  name: "update_library_item",
  title: "Describe a library image",
  description:
    "Rewrite a library item's name, description, usage or tags. Fields you leave out keep their value. " +
    "Tags you send replace the item's tags. An item's kind cannot change, because slideshows already " +
    "place it as a background or an asset.",
  inputSchema: {
    id: z.string().describe("Library item id."),
    name: z.string().optional(),
    description: z.string().optional().describe("What the image shows."),
    usage: z.string().optional().describe("When and how to use it on a slide."),
    tags: TAGS_SHAPE.optional(),
  },
  async handler({ id, name, description, usage, tags }, { library, baseUrl }) {
    const item = library.update(id, { name, description, usage, tags });
    return json({ item: withAbsoluteUrl(item, baseUrl()) });
  },
});

const PREVIEW_WIDTH = 540;

const previewSlideshow = defineTool({
  name: "preview_slideshow",
  title: "Preview a slideshow",
  description:
    "See a slideshow before the human does: one JPEG per slide, drawn on the server from the stored layout, in " +
    "any status. The preview is approximate. Text is measured by estimate, so a line can wrap at a different word " +
    "than in the editor, and a font added from Google Fonts is drawn in another face. Treat it as a " +
    "check, not as the export. The last block is JSON with `approximate`, the `version` drawn and `warnings`: " +
    "text that reaches past the slide edge (`text-out-of-frame`), text with more lines than its box shows " +
    "(`text-cut`) and an image drawn over a text (`overlay-over-text`). Fix a warning with update_slideshow, " +
    "for example with shorter lines, then preview again.",
  inputSchema: {
    id: z.string().describe("Slideshow id."),
    slides: z
      .array(z.number().int().min(1))
      .min(1)
      .optional()
      .describe("Slide numbers to draw, counting from 1. Defaults to every slide."),
    width: z
      .number()
      .int()
      .min(108)
      .max(1080)
      .optional()
      .describe(`Width of each image in pixels. Defaults to ${String(PREVIEW_WIDTH)}.`),
  },
  async handler({ id, slides, width }, { projects, library, media, fonts }) {
    const project = projects.require(id);
    const count = project.slides.length;
    const missing = (slides ?? []).filter((number) => number > count);
    if (missing.length > 0) {
      throw new HttpError(
        400,
        `This slideshow has ${String(count)} slides, so there is no slide ${missing.join(", ")}.`,
      );
    }
    // A Set, so repeating a number cannot multiply the work or the response.
    const numbers = [
      ...new Set(slides ?? project.slides.map((_slide, index) => index + 1)),
    ];
    const preview = await renderPreview(
      { library, media, fonts },
      project,
      numbers,
      width ?? PREVIEW_WIDTH,
    );
    return {
      content: [
        ...preview.slides.map((slide) => ({
          type: "image" as const,
          mimeType: "image/jpeg",
          data: slide.jpeg.toString("base64"),
        })),
        ...json({
          approximate: true,
          version: project.version,
          slides: preview.slides.map(({ slide, width, height }) => ({
            slide,
            width,
            height,
          })),
          warnings: preview.warnings,
        }).content,
      ],
    };
  },
});

/** Every tool, list_accounts first so an agent can see its brand before anything else. */
export const tools = {
  list_accounts: listAccounts,
  list_library: listLibrary,
  get_library_item: getLibraryItem,
  list_slideshows: listSlideshows,
  get_slideshow: getSlideshow,
  set_slideshow_status: setSlideshowStatus,
  create_slideshow: createSlideshow,
  update_slideshow: updateSlideshow,
  duplicate_slideshow: duplicateSlideshow,
  delete_slideshow: deleteSlideshow,
  export_slideshow: exportSlideshow,
  revoke_export: revokeExport,

  create_account: createAccount,
  update_account: updateAccount,
  add_library_item: addLibraryItem,
  update_library_item: updateLibraryItem,

  preview_slideshow: previewSlideshow,
};
