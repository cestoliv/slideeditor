import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BUILTIN_DEFAULTS, type AccountDefaults } from "../../shared/schema/index.js";
import { z } from "zod";
import {
  addItem,
  asHttpError,
  catchError,
  createTestApp,
  noisyPng,
  pngFixture,
  solidPng,
  type TestApp,
} from "../testing.js";
import { tools, type ToolContext, type ToolResult } from "./tools.js";

let harness: TestApp;
let context: ToolContext;

const ACCOUNT_ID = "default";

beforeEach(() => {
  harness = createTestApp();
  context = {
    library: harness.services.library,
    projects: harness.services.projects,
    accounts: harness.services.accounts,
    fonts: harness.services.fonts,
    exports: harness.services.exports,
    media: harness.services.media,
    baseUrl: () => "http://localhost:4173",
  };
});

afterEach(() => {
  harness.close();
});

/** Every tool answers with one JSON text block, so every test reads it the same way. */
function payload(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.type === "text" ? first.text : "") as Record<string, unknown>;
}

async function background(name = "Sunset", accountId = ACCOUNT_ID): Promise<string> {
  return (await addItem(harness.services.library, "background", name, { accountId })).id;
}

/**
 * Finding 13: an account default's fontFamily now has to name a real row in
 * the font table (services/accounts.ts's assertKnownFont), so a test whose
 * account uses a family other than the seeded builtins has to add it first.
 * Inserted directly rather than through FontService.addGoogleFont(), which
 * would reach the real network — this only needs the row to exist.
 */
function seedFont(family: string): void {
  harness.db
    .prepare(
      `INSERT INTO font (id, family, source, weight, media_id, ext, created_at)
       VALUES (?, ?, 'google', 400, 'm1', 'woff2', ?)`,
    )
    .run(family, family, Date.now());
}

async function asset(name = "Arrow"): Promise<string> {
  return (await addItem(harness.services.library, "asset", name)).id;
}

it("lists accounts so an agent can see the brand it writes into", async () => {
  const result = await tools.list_accounts.handler({}, context);
  const body = payload(result) as { accounts: { id: string; name: string }[] };
  expect(body.accounts.some((account) => account.id === "default")).toBe(true);
});

it("requires an accountId on create_slideshow", async () => {
  const id = await background();
  const created = await tools.create_slideshow.handler(
    { accountId: "default", slides: [{ background: id }] },
    context,
  );
  const body = payload(created) as { id: string };
  const summary = payload(
    await tools.list_slideshows.handler({ accountId: "default" }, context),
  ) as { slideshows: { id: string }[] };
  expect(summary.slideshows.map((item) => item.id)).toContain(body.id);
});

/*
 * The point of the whole feature: an agent drafting into a non-default
 * account gets that account's own typography, not the seeded default's.
 * Task 7 left both handlers hardcoded to BUILTIN_DEFAULTS/DEFAULT_ACCOUNT_ID
 * on purpose, deferring the real resolution to this task.
 */
it("styles an agent-created slide with its own account's defaults, not the built-in default", async () => {
  seedFont("Bebas Neue");
  const account = context.accounts.create({
    name: "Side project",
    defaults: {
      ratio: { w: 3, h: 4 },
      text: {
        fontFamily: "Bebas Neue",
        size: 40,
        style: "boxed",
        color: "#111111",
        background: "white",
        backgroundShape: "full",
        align: "left",
      },
    },
  });
  // The background belongs to this same account: validateComposition (frozen,
  // Task 5) refuses a slide that mixes in another account's library items, so
  // this is not the shared `background()` default-account fixture.
  const id = await background("Sunset", account.id);
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: account.id, slides: [{ background: id, texts: ["Launch day"] }] },
      context,
    ),
  ) as { id: string };
  const project = harness.services.projects.require(created.id);
  const text = (project.slides[0] as { texts: { fontFamily: string; size: number }[] })
    .texts[0];
  expect(text?.fontFamily).toBe("Bebas Neue");
  expect(text?.size).toBe(40);
});

it("lists library items with their usage stats", async () => {
  await background();
  const result = await tools.list_library.handler(
    { kind: "background", limit: 10 },
    context,
  );
  const body = payload(result) as {
    total: number;
    items: { name: string; stats: unknown }[];
  };
  expect(body.total).toBe(1);
  expect(body.items[0]?.name).toBe("Sunset");
  expect(body.items[0]?.stats).toMatchObject({
    timesUsed: 0,
    slideshowCount: 0,
    lastUsedAt: null,
  });
});

it("counts a use once the item is on a slide", async () => {
  const id = await background();
  await tools.create_slideshow.handler(
    { accountId: ACCOUNT_ID, slides: [{ background: id }] },
    context,
  );
  const result = await tools.list_library.handler({}, context);
  const body = payload(result) as { items: { stats: { timesUsed: number } }[] };
  expect(body.items[0]?.stats.timesUsed).toBe(1);
});

it("filters the library list by account", async () => {
  const id = await background();
  const body = payload(
    await tools.list_library.handler({ accountId: "default" }, context),
  ) as { items: { id: string }[] };
  expect(body.items.map((item) => item.id)).toContain(id);
});

// No account has "" as its id, so an empty accountId must narrow the result
// to nothing rather than being treated as "no filter" and searching every
// account.
it("narrows to nothing rather than every account on an empty accountId", async () => {
  await background();
  const body = payload(await tools.list_library.handler({ accountId: "" }, context)) as {
    items: unknown[];
  };
  expect(body.items).toEqual([]);
});

it("hides the media fields the editor needs and the agent does not", async () => {
  await background();
  const body = payload(await tools.list_library.handler({}, context)) as {
    items: Record<string, unknown>[];
  };
  expect(Object.keys(body.items[0] ?? {})).toEqual([
    "id",
    "kind",
    "name",
    "description",
    "usage",
    "tags",
    "accountId",
    "width",
    "height",
    "url",
    "stats",
  ]);
});

it("reads one library item with the slideshows that use it", async () => {
  const id = await background();
  await tools.create_slideshow.handler(
    { accountId: ACCOUNT_ID, name: "Launch", slides: [{ background: id }] },
    context,
  );
  const body = payload(await tools.get_library_item.handler({ id }, context)) as {
    item: { id: string; url: string };
    usedBy: { name: string }[];
  };
  expect(body.item.id).toBe(id);
  expect(body.item.url).toContain("/media/");
  expect(body.usedBy).toEqual([expect.objectContaining({ name: "Launch" })]);
});

it("names the wrong kind when a background id is passed as an asset", async () => {
  const assetId = await asset();
  await expect(
    tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: assetId }] },
      context,
    ),
  ).rejects.toThrow(/is an asset, expected a background/);
});

it("returns the edit URL from create_slideshow", async () => {
  const id = await background();
  const body = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        name: "Launch",
        slides: [{ background: id, texts: ["Hello"] }],
      },
      context,
    ),
  ) as { id: string; version: number; slideCount: number; editUrl: string };
  expect(body.version).toBe(1);
  expect(body.slideCount).toBe(1);
  expect(body.editUrl).toBe(`http://localhost:4173/projects/${body.id}`);
});

it("names the slideshow itself when the agent gives it none", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string };
  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { name: string };
  };
  expect(read.slideshow.name).toBe("Agent slideshow");
});

it("refuses a slideshow with no slides", async () => {
  await expect(
    tools.create_slideshow.handler({ accountId: ACCOUNT_ID, slides: [] }, context),
  ).rejects.toThrow(/needs at least one slide/);
});

it("reads a slideshow back as the composition the agent wrote", async () => {
  const backgroundId = await background();
  const assetId = await asset();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: backgroundId, assets: [assetId], texts: ["One", "Two"] }],
      },
      context,
    ),
  ) as { id: string };

  const body = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { version: number; status: string; slides: unknown[]; accountId: string };
    editUrl: string;
  };
  expect(body.slideshow.status).toBe("draft");
  expect(body.slideshow.version).toBe(1);
  expect(body.slideshow.accountId).toBe(ACCOUNT_ID);
  expect(body.slideshow.slides).toEqual([
    expect.objectContaining({
      background: backgroundId,
      assets: [assetId],
      texts: ["One", "Two"],
    }),
  ]);
  // Layout is deliberately not exposed, so no geometry comes back.
  expect(JSON.stringify(body.slideshow)).not.toContain("overlays");
});

it("refuses an update carrying a stale version", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };

  await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version,
      slides: [{ background: id, texts: ["Second"] }],
    },
    context,
  );

  await expect(
    tools.update_slideshow.handler(
      { id: created.id, version: created.version, slides: [{ background: id }] },
      context,
    ),
  ).rejects.toThrow(/changed since you loaded it/);
});

it("bumps the version and keeps the id on a good update", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };

  const updated = payload(
    await tools.update_slideshow.handler(
      {
        id: created.id,
        version: created.version,
        slides: [{ background: id }, { background: id, texts: ["Second"] }],
      },
      context,
    ),
  ) as { id: string; version: number; slideCount: number };
  expect(updated.id).toBe(created.id);
  expect(updated.version).toBe(2);
  expect(updated.slideCount).toBe(2);
});

/*
 * Task 7 left updateSlideshow hardcoded to BUILTIN_DEFAULTS too, with a
 * comment marking it as this task's job: left unfixed, an agent editing a
 * slideshow in a non-default account would style any newly added text with
 * the wrong brand's look.
 */
it("keeps styling text added by update_slideshow with the slideshow's own account defaults", async () => {
  seedFont("Bebas Neue");
  const account = context.accounts.create({
    name: "Side project",
    defaults: {
      ratio: { w: 3, h: 4 },
      text: {
        fontFamily: "Bebas Neue",
        size: 40,
        style: "boxed",
        color: "#111111",
        background: "white",
        backgroundShape: "full",
        align: "left",
      },
    },
  });
  // Same reason as the create_slideshow styling test above: the background
  // must belong to this account, or validateComposition refuses the slide.
  const id = await background("Sunset", account.id);
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: account.id, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };
  const updated = payload(
    await tools.update_slideshow.handler(
      {
        id: created.id,
        version: created.version,
        slides: [{ background: id, texts: ["New line"] }],
      },
      context,
    ),
  ) as { id: string };
  const project = harness.services.projects.require(updated.id);
  const text = (project.slides[0] as { texts: { fontFamily: string; size: number }[] })
    .texts[0];
  expect(text?.fontFamily).toBe("Bebas Neue");
  expect(text?.size).toBe(40);
});

it("hides published slideshows unless status is all", async () => {
  const id = await background();
  const open = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, name: "Open", slides: [{ background: id }] },
      context,
    ),
  ) as { id: string };
  const done = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, name: "Done", slides: [{ background: id }] },
      context,
    ),
  ) as { id: string };
  await tools.set_slideshow_status.handler({ id: done.id, status: "published" }, context);

  const listed = payload(await tools.list_slideshows.handler({}, context)) as {
    slideshows: { id: string; editUrl: string }[];
  };
  expect(listed.slideshows.map((slideshow) => slideshow.id)).toEqual([open.id]);
  expect(listed.slideshows[0]?.editUrl).toBe(`http://localhost:4173/projects/${open.id}`);

  const all = payload(
    await tools.list_slideshows.handler({ status: "all" }, context),
  ) as {
    slideshows: { id: string }[];
  };
  expect(all.slideshows.map((slideshow) => slideshow.id).sort()).toEqual(
    [done.id, open.id].sort(),
  );

  const published = payload(
    await tools.list_slideshows.handler({ status: ["published"] }, context),
  ) as { slideshows: { id: string }[] };
  expect(published.slideshows.map((slideshow) => slideshow.id)).toEqual([done.id]);
});

it("sets a status without bumping the version", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };

  const body = payload(
    await tools.set_slideshow_status.handler(
      { id: created.id, status: "ready" },
      context,
    ),
  ) as { id: string; status: string; editUrl: string };
  expect(body.status).toBe("ready");
  expect(body.editUrl).toBe(`http://localhost:4173/projects/${created.id}`);

  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { version: number; status: string };
  };
  expect(read.slideshow.version).toBe(created.version);
  expect(read.slideshow.status).toBe("ready");
});

it("says which slideshow is missing", async () => {
  await expect(tools.get_slideshow.handler({ id: "nope" }, context)).rejects.toThrow(
    /No slideshow with id nope/,
  );
});

/**
 * Transcribed out of the original with
 * `git show c6b3970:server/mcp.mjs`, not copied from the port beside this test,
 * so this is an independent record rather than a restatement. An agent reads
 * these strings to decide which tool to call and how, and the README quotes
 * them, so a silent edit is a contract change.
 */
const PINNED = [
  {
    name: "list_accounts",
    title: "List accounts",
    description:
      "List every account: its id, name and defaults. Pass an id as accountId to create_slideshow, list_slideshows or list_library. Every slideshow and library item belongs to exactly one account.",
  },
  {
    name: "list_library",
    title: "List library images",
    description:
      "List or search the background and asset libraries. Read each item's `description` (what the image shows) and `usage` (when and how to use it) to choose well. Each item also carries `stats`, a record of how often it has been used before. When several items fit the slide equally well, pick the one with the lower `stats.timesUsed`, or the older `stats.lastUsedAt`, so slideshows do not all end up looking the same. Sort by `least-used` to see the neglected ones first. A background without `layoutHints` has not been reviewed yet: open its `url`, look at it, and write them with update_library_item. Returns ids to pass to create_slideshow.",
  },
  {
    name: "get_library_item",
    title: "Read one library image",
    description:
      "Read the full record for one library item, including its description and usage guidance.",
  },
  {
    name: "list_slideshows",
    title: "List slideshows",
    description:
      "List slideshows with their id, version, status, caption, slide count and edit URL. Published slideshows are hidden by default, because that work is already posted. Pass status to widen the list. Pass accountId to see one account's slideshows only; omit it to see every account's.",
  },
  {
    name: "get_slideshow",
    title: "Read a slideshow",
    description:
      "Read one slideshow as a composition: per slide, its background id, asset ids and texts. Also returns the caption: `description` and `hashtags`, and the `accountId` it belongs to. A slide composed with anchors also carries its `layout`. Coordinates are deliberately not exposed. Use the returned `version` when calling update_slideshow. `layoutChanged` counts the slides the human changed by hand since the slideshow was created or duplicated, or is null when no agent composed it.",
  },
  {
    name: "set_slideshow_status",
    title: "Set a slideshow's status",
    description:
      "Move a slideshow between draft, ready and published. `draft` is work in progress and is where every new slideshow starts. `ready` means the human has finished adjusting it. `published` means it has been posted, and hides it from the default list. Status is only a label: it never locks editing, and changing it does not bump the version.",
  },
  {
    name: "create_slideshow",
    title: "Create a slideshow",
    description:
      "Draft a slideshow from library images and text, in one account. Each slide takes one background id, any number of asset ids and any number of text lines. Write the caption too: a slideshow exists to be posted, so `description` and `hashtags` are part of the draft rather than an afterthought. You never send coordinates: the server lays everything out from the account's defaults and the human adjusts it by hand afterwards. It keeps texts and assets clear of the TikTok buttons and caption, puts a lone asset top left, and stacks the texts below it: high on the first slide, mid-height in the middle, lower on the last. A text line can carry its own size, colour and style when one line has to stand out. Then call preview_slideshow. Where a text covers a face or a key part of the image, move it with that slide's `layout` anchors through update_slideshow, and preview the changed slides again. Stop after two rounds and report what is still wrong. Call list_accounts first if you do not already know the accountId. Returns the edit URL to hand back to the user, and `notes` when an anchor could not be honoured.",
  },
  {
    name: "update_slideshow",
    title: "Update a slideshow",
    description:
      "Replace a slideshow's composition. Pass the `version` you read from get_slideshow: a stale version is rejected so you cannot overwrite the human's work. Slides whose composition and `layout` anchors are unchanged keep the layout the human adjusted, and geometry is preserved for any asset or text that is still present. Send back the `layout` get_slideshow returns, or the slide is laid out again from its defaults. To fix a slide the preview shows wrong, change only its anchors: that slide is laid out again and the others keep their geometry. Fix a slide at most twice. A caption field you leave out keeps what is stored, so editing the slides never wipes a caption the human has been working on. Send an empty string to clear one on purpose.",
  },
  {
    name: "duplicate_slideshow",
    title: "Duplicate a slideshow",
    description:
      "Copy a slideshow into a new draft in the same account, layout and all. Use it to start from a template the human has already adjusted: duplicate it, then change the texts with update_slideshow. Slides and lines you leave unchanged keep the human's layout. The copy keeps the caption unless you pass a new one. Returns the new id and version.",
  },
  {
    name: "delete_slideshow",
    title: "Delete a draft slideshow",
    description:
      "Delete a slideshow for good. Only a draft can be deleted: a ready or published slideshow is refused, because the human has signed it off. To delete one of those, ask the human to move it back to draft.",
  },
  {
    name: "export_slideshow",
    title: "Export a slideshow as image URLs",
    description:
      "Get one temporary public image URL per slide, in order, ready to hand to a scheduling tool such as Metricool that downloads media by URL. The slideshow has to be `ready`, and the `version` you pass has to be the one stored, so you can never publish a composition that has moved on. The URLs need no cookie and no token, and they stop working after 45 minutes. Slides come back as JPEG at quality 92 unless you ask for `png` or `webp`, always over an opaque white background, so a transparent pixel never reaches a feed composited against something else. `quality` runs from 1 to 100 and is refused with `png`, which is lossless. Each slide also carries its width, height, byte count and sha256, so you can check that what was downloaded is what was rendered. A `status` of `pending` means the human has not opened the editor since this version became ready: the pixels are drawn in the browser, so ask them to open the edit URL, then call again. Call revoke_export once the import is done.",
  },
  {
    name: "revoke_export",
    title: "Revoke a slideshow's export URLs",
    description:
      "Stop every temporary URL this slideshow has handed out, before they expire on their own. Call it once the scheduling tool has finished downloading. It revokes PNG, JPEG and WebP URLs alike. The rendered images are kept, so a later export_slideshow still works without the human re-rendering anything.",
  },
  {
    name: "create_account",
    title: "Create an account",
    description:
      "Create an account: one brand, with its own library and slideshows. Partial `defaults` inherit the built-in defaults. Returns the account, whose id you pass as accountId to the other tools.",
  },
  {
    name: "update_account",
    title: "Update an account",
    description:
      "Rename an account or change its defaults. Fields you leave out keep their value. New defaults apply to slideshows created afterwards only: an existing slideshow keeps its ratio and layout.",
  },
  {
    name: "add_library_item",
    title: "Add a library image",
    description:
      "Add one image to an account's library, from a public `url` or from base64 `data`. Pass exactly one. PNG, JPEG, WebP and GIF up to 25 MB are accepted. A URL has 10 seconds to download and must not point at a private address. Write `description` (what the image shows) and `usage` (when to use it): list_library is how you choose images later, and it reads only those. If the account already holds the same image as the same kind, nothing is added: the existing item comes back with `duplicateOf`, so an import can be run again safely. For a background, look at the image and fill `layoutHints`.",
  },
  {
    name: "update_library_item",
    title: "Describe a library image",
    description:
      "Rewrite a library item's name, description, usage, tags or layout hints. Fields you leave out keep their value. Tags and layout hints you send replace the old ones, and `layoutHints: null` clears them. When you review a background, look at its image and fill `layoutHints`. Hints change only slides composed afterwards. An item's kind cannot change, because slideshows already place it as a background or an asset.",
  },
  {
    name: "preview_slideshow",
    title: "Preview a slideshow",
    description:
      "See a slideshow before the human does: one JPEG per slide, drawn on the server from the stored layout, in any status. The preview is approximate. Text is measured by estimate, so a line can wrap at a different word than in the editor, and a font added from Google Fonts is drawn in another face. Treat it as a check, not as the export. The last block is JSON with `approximate`, the `version` drawn and `warnings`: text that reaches past the slide edge (`text-out-of-frame`), text with more lines than its box shows (`text-cut`), an image drawn over a text (`overlay-over-text`) and a text or image outside the zone TikTok keeps clear of its tabs, caption and buttons (`outside-safe-zone`). A text anchor moves a text up or down only, so a text past the right edge of the zone needs shorter lines. Look at each image too: a text over a face or over the key part of a screenshot needs moving. Fix a slide with update_slideshow, by changing its `layout` anchors or by shortening its lines, then preview only the slides you changed. Stop after two rounds and report what is still wrong.",
  },
];

it("keeps every tool's name, title and description word for word", () => {
  expect(Object.keys(tools)).toEqual(PINNED.map((tool) => tool.name));
  expect(
    Object.values(tools).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })),
  ).toEqual(PINNED);
});

/** The shape this test reaches into: one text layer's geometry on one slide. */
interface StoredSlide {
  id: string;
  texts: { text: string; x: number; y: number }[];
}

function slidesOf(id: string): StoredSlide[] {
  return harness.services.projects.require(id).slides as StoredSlide[];
}

it("keeps the geometry a human adjusted when the composition is unchanged", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id, texts: ["Hello"] }] },
      context,
    ),
  ) as { id: string; version: number };

  // Stand in for the human: open the editor, drag the text, save. Anything but
  // the composition itself, which the agent still owns.
  const project = harness.services.projects.require(created.id);
  const moved = slidesOf(created.id);
  const text = moved[0]?.texts[0];
  if (!text) throw new Error("The composed slide carries no text.");
  text.x = 0.111;
  text.y = 0.222;
  const slideId = moved[0]?.id;
  harness.services.projects.save(created.id, {
    document: { ratio: project.ratio, slides: moved },
    version: created.version,
  });

  // The agent adds a second slide and leaves the first one's composition alone.
  await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version + 1,
      slides: [
        { background: id, texts: ["Hello"] },
        { background: id, texts: ["Second"] },
      ],
    },
    context,
  );

  const after = slidesOf(created.id);
  expect(after).toHaveLength(2);
  expect(after[0]?.id).toBe(slideId);
  // Without `previous`, this text is laid out from scratch and lands back on the
  // default margin, throwing the human's positioning away.
  expect(after[0]?.texts[0]).toMatchObject({ text: "Hello", x: 0.111, y: 0.222 });
});

it("keeps the current ratio when an update carries none", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, ratio: { w: 4, h: 5 }, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };
  expect(harness.services.projects.require(created.id).ratio).toEqual({ w: 4, h: 5 });

  await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version,
      slides: [{ background: id, texts: ["Next"] }],
    },
    context,
  );
  expect(harness.services.projects.require(created.id).ratio).toEqual({ w: 4, h: 5 });
});

it("keeps the current name when an update carries none", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, name: "Launch", slides: [{ background: id }] },
      context,
    ),
  ) as { id: string; version: number };

  await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version,
      slides: [{ background: id, texts: ["Next"] }],
    },
    context,
  );
  expect(harness.services.projects.require(created.id).name).toBe("Launch");

  const renamed = await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version + 1,
      name: "Relaunch",
      slides: [{ background: id }],
    },
    context,
  );
  expect(payload(renamed)).toMatchObject({ version: created.version + 2 });
  expect(harness.services.projects.require(created.id).name).toBe("Relaunch");
});

// ---------------------------------------------------------------------------
// The caption an agent drafts and a person posts.

it("drafts a caption alongside the slides and reads it back", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: id }],
        description: "Five things to know first",
        hashtags: ["travel", "#summer"],
      },
      context,
    ),
  ) as { id: string; description: string; hashtags: string };

  // Echoed on the write, so an agent sees what its list of tags became.
  expect(created.description).toBe("Five things to know first");
  expect(created.hashtags).toBe("#travel #summer");

  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { description: string; hashtags: string };
  };
  expect(read.slideshow.description).toBe("Five things to know first");
  expect(read.slideshow.hashtags, "one shape comes back, whatever went in").toBe(
    "#travel #summer",
  );
});

it("takes a caption's hashtags as one string too", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: id }],
        hashtags: "travel, #Travel summer",
      },
      context,
    ),
  ) as { hashtags: string };
  expect(created.hashtags).toBe("#travel #summer");
});

it("leaves the caption alone when an update only changes the slides", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: id }],
        description: "Written first",
        hashtags: "#travel",
      },
      context,
    ),
  ) as { id: string; version: number };

  const updated = payload(
    await tools.update_slideshow.handler(
      {
        id: created.id,
        version: created.version,
        slides: [{ background: id, texts: ["Second thought"] }],
      },
      context,
    ),
  ) as { description: string; hashtags: string };

  expect(updated.description, "editing slides must not wipe a caption").toBe(
    "Written first",
  );
  expect(updated.hashtags).toBe("#travel");
});

it("rewrites a caption when the update carries one", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: id }],
        description: "First draft",
        hashtags: "#travel",
      },
      context,
    ),
  ) as { id: string; version: number };

  const updated = payload(
    await tools.update_slideshow.handler(
      {
        id: created.id,
        version: created.version,
        slides: [{ background: id }],
        description: "Second draft",
        hashtags: ["summer"],
      },
      context,
    ),
  ) as { description: string; hashtags: string };

  expect(updated.description).toBe("Second draft");
  expect(updated.hashtags).toBe("#summer");
});

it("carries the caption in the list, so choosing a slideshow needs one call", async () => {
  const id = await background();
  await tools.create_slideshow.handler(
    {
      accountId: ACCOUNT_ID,
      slides: [{ background: id }],
      description: "Listed caption",
      hashtags: "am",
    },
    context,
  );
  const listed = payload(await tools.list_slideshows.handler({}, context)) as {
    slideshows: { description: string; hashtags: string }[];
  };
  expect(listed.slideshows[0]?.description).toBe("Listed caption");
  expect(listed.slideshows[0]?.hashtags).toBe("#am");
});

it("takes a slideshow with no caption as one carrying none", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: id }] },
      context,
    ),
  ) as { id: string };
  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { description: string; hashtags: string };
  };
  expect(read.slideshow.description).toBe("");
  expect(read.slideshow.hashtags).toBe("");
});

/**
 * A ready slideshow with one real rendered PNG on disk.
 *
 * The bytes have to exist now that export_slideshow converts them, so this
 * files them through MediaStore rather than naming a hash nothing wrote.
 * Takes the PNG bytes rather than always building them, because a flat
 * solidPng compresses to the same size at every JPEG quality and one test
 * below needs bytes that do not.
 */
async function readySlideshow(
  png: Buffer = solidPng(1080, 1440),
): Promise<{ id: string; version: number }> {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: backgroundId }] },
      context,
    ),
  ) as { id: string; version: number };
  await tools.set_slideshow_status.handler({ id: created.id, status: "ready" }, context);
  const mediaId = await harness.services.media.put(png, "png");
  // Read back from IHDR, which every PNG puts first, so the row cannot claim a
  // size the file does not have when a test passes its own fixture.
  harness.services.exports.putRender(created.id, created.version, 0, {
    mediaId,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bytes: png.byteLength,
  });
  return created;
}

it("hands back one signed URL per slide, in order", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler({ id, version, format: "png" }, context),
  ) as {
    slideshowId: string;
    version: number;
    status: string;
    format: string;
    quality: number;
    ratio: { w: number; h: number };
    expiresAt: string;
    slides: {
      index: number;
      url: string;
      mimeType: string;
      width: number;
      height: number;
      bytes: number;
      sha256: string;
    }[];
  };
  expect(body.slideshowId).toBe(id);
  expect(body.version).toBe(version);
  expect(body.status).toBe("ready");
  expect(body.format).toBe("png");
  expect(body.ratio).toEqual({ w: 9, h: 16 });
  expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  expect(body.slides).toHaveLength(1);
  const first = body.slides[0];
  // 1-based for the caller, whatever the table stores.
  expect(first?.index).toBe(1);
  expect(first?.url).toMatch(/^http:\/\/localhost:4173\/export\/[0-9a-f]{64}\/01\.png$/);
  expect(first?.mimeType).toBe("image/png");
  expect(first?.width).toBe(1080);
  expect(first?.height).toBe(1440);
  expect(first?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(first?.bytes).toBeGreaterThan(0);
});

// Every other export test files one slide, so nothing else reaches the index
// where the printed number grows a second digit. This one pins the 1-based
// offset and the ordering there: slide 10 reports index 10 and ends at
// "10.png", the first name that fills Task 4's /^(\d{2})\.png$/ route match
// without padding. Catching a pad narrowed to one digit is the one-slide
// case's job above, since padStart(1, "0") leaves "10" alone.
it("numbers the tenth slide 10 and serves it at 10.png", async () => {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: Array.from({ length: 10 }, () => ({ background: backgroundId })),
      },
      context,
    ),
  ) as { id: string; version: number };
  await tools.set_slideshow_status.handler({ id: created.id, status: "ready" }, context);
  const png = solidPng(1080, 1440);
  const mediaId = await harness.services.media.put(png, "png");
  for (let index = 0; index < 10; index += 1) {
    harness.services.exports.putRender(created.id, created.version, index, {
      mediaId,
      width: 1080,
      height: 1440,
      bytes: png.byteLength,
    });
  }
  const body = payload(
    await tools.export_slideshow.handler(
      { id: created.id, version: created.version, format: "png" },
      context,
    ),
  ) as { slides: { index: number; url: string }[] };
  const tenth = body.slides[9];
  expect(tenth?.index).toBe(10);
  expect(tenth?.url).toMatch(/\/10\.png$/);
});

it("converts to jpeg at quality 92 when no format is named", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler({ id, version }, context),
  ) as {
    format: string;
    quality: number;
    slides: { url: string; mimeType: string; bytes: number; sha256: string }[];
  };
  expect(body.format).toBe("jpeg");
  expect(body.quality).toBe(92);
  const first = body.slides[0];
  expect(first?.url).toMatch(/\/01\.jpg$/);
  expect(first?.mimeType).toBe("image/jpeg");
  // The answer describes the converted file, so the checksum has to be the
  // checksum of bytes that exist.
  const stored = await harness.services.media.read(first?.sha256 ?? "", "jpg");
  expect(stored.byteLength).toBe(first?.bytes);
});

it("converts to webp when webp is asked for", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler(
      { id, version, format: "webp", quality: 70 },
      context,
    ),
  ) as { format: string; quality: number; slides: { url: string; mimeType: string }[] };
  expect(body.format).toBe("webp");
  expect(body.quality).toBe(70);
  expect(body.slides[0]?.url).toMatch(/\/01\.webp$/);
  expect(body.slides[0]?.mimeType).toBe("image/webp");
});

it("refuses a quality alongside png", async () => {
  const { id, version } = await readySlideshow();
  const error = asHttpError(
    await catchError(() =>
      tools.export_slideshow.handler(
        { id, version, format: "png", quality: 60 },
        context,
      ),
    ),
  );
  expect(error.status).toBe(400);
  expect(error.message).toContain("lossless");
});

it("converts once and reuses the file on a second export", async () => {
  const { id, version } = await readySlideshow();
  const first = payload(
    await tools.export_slideshow.handler({ id, version }, context),
  ) as { slides: { sha256: string; url: string }[] };
  const second = payload(
    await tools.export_slideshow.handler({ id, version }, context),
  ) as { slides: { sha256: string; url: string }[] };
  // A new token every time, the same converted file underneath it.
  expect(second.slides[0]?.url).not.toBe(first.slides[0]?.url);
  expect(second.slides[0]?.sha256).toBe(first.slides[0]?.sha256);
  const rows = harness.db
    .prepare("SELECT COUNT(*) AS n FROM slideshow_render_variant WHERE slideshow_id = ?")
    .get(id);
  expect(rows?.["n"]).toBe(1);
});

it("keeps two qualities of the same version apart", async () => {
  // Small on purpose. The claim is that quality reaches the encoder, which
  // noise proves at any size, and a full 1080x1440 of random bytes costs
  // several seconds of PNG encoding before the two JPEG passes even start.
  const { id, version } = await readySlideshow(await noisyPng(240, 320));
  const dear = payload(
    await tools.export_slideshow.handler({ id, version, quality: 92 }, context),
  ) as { slides: { bytes: number }[] };
  const cheap = payload(
    await tools.export_slideshow.handler({ id, version, quality: 30 }, context),
  ) as { slides: { bytes: number }[] };
  expect(cheap.slides[0]?.bytes).toBeLessThan(dear.slides[0]?.bytes ?? 0);
});

it("reports pending before it converts anything", async () => {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: backgroundId }] },
      context,
    ),
  ) as { id: string; version: number };
  await tools.set_slideshow_status.handler({ id: created.id, status: "ready" }, context);
  const body = payload(
    await tools.export_slideshow.handler(
      { id: created.id, version: created.version, format: "jpeg" },
      context,
    ),
  ) as { status: string };
  expect(body.status).toBe("pending");
  const rows = harness.db
    .prepare("SELECT COUNT(*) AS n FROM slideshow_render_variant")
    .get();
  expect(rows?.["n"]).toBe(0);
});

it("warns when the URLs it just built point at this machine only", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler({ id, version }, context),
  ) as { warning?: string };
  expect(body.warning).toContain("--public-url");
});

it("omits the warning when the base URL is reachable", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler(
      { id, version },
      { ...context, baseUrl: () => "https://studio.example.com" },
    ),
  ) as { warning?: string; slides: { url: string }[] };
  expect(body.warning).toBeUndefined();
  expect(body.slides[0]?.url.startsWith("https://studio.example.com/export/")).toBe(true);
});

// The CLI's own wildcard bind, which the auth layer already treats as public
// (src/server/auth/mode.ts's resolveAuthMode) even though it is unreachable
// as a URL host: nothing on another machine can dial 0.0.0.0.
it("warns when the base URL is the wildcard bind address", async () => {
  const { id, version } = await readySlideshow();
  const body = payload(
    await tools.export_slideshow.handler(
      { id, version },
      { ...context, baseUrl: () => "http://0.0.0.0:4173" },
    ),
  ) as { warning?: string };
  expect(body.warning).toContain("--public-url");
});

it("refuses to export a slideshow that is still a draft", async () => {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: backgroundId }] },
      context,
    ),
  ) as { id: string; version: number };
  const error = asHttpError(
    await catchError(() =>
      tools.export_slideshow.handler(
        { id: created.id, version: created.version },
        context,
      ),
    ),
  );
  expect(error.status).toBe(409);
  expect(error.message).toContain("draft");
});

it("refuses a version other than the one stored", async () => {
  const { id } = await readySlideshow();
  const error = asHttpError(
    await catchError(() => tools.export_slideshow.handler({ id, version: 99 }, context)),
  );
  expect(error.status).toBe(409);
  expect(error.details?.["currentVersion"]).toBe(1);
});

it("refuses a slideshow that does not exist", async () => {
  const error = asHttpError(
    await catchError(() =>
      tools.export_slideshow.handler({ id: "nope", version: 1 }, context),
    ),
  );
  expect(error.status).toBe(404);
});

it("reports pending, not failure, when the editor has not rendered yet", async () => {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: backgroundId }] },
      context,
    ),
  ) as { id: string; version: number };
  await tools.set_slideshow_status.handler({ id: created.id, status: "ready" }, context);
  const body = payload(
    await tools.export_slideshow.handler(
      { id: created.id, version: created.version },
      context,
    ),
  ) as { status: string; slides?: unknown[]; editUrl: string };
  expect(body.status).toBe("pending");
  expect(body.slides).toBeUndefined();
  expect(body.editUrl).toContain(created.id);
});

it("reports pending while only some slides have rendered", async () => {
  const first = await background("One");
  const second = await background("Two");
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: first }, { background: second }],
      },
      context,
    ),
  ) as { id: string; version: number };
  await tools.set_slideshow_status.handler({ id: created.id, status: "ready" }, context);
  harness.services.exports.putRender(created.id, created.version, 0, {
    mediaId: "b".repeat(64),
    width: 1080,
    height: 1920,
    bytes: 10,
  });
  const body = payload(
    await tools.export_slideshow.handler(
      { id: created.id, version: created.version },
      context,
    ),
  ) as { status: string };
  expect(body.status).toBe("pending");
});

it("revokes every grant and leaves the renders in place", async () => {
  const { id, version } = await readySlideshow();
  await tools.export_slideshow.handler({ id, version }, context);
  await tools.export_slideshow.handler({ id, version }, context);
  const body = payload(await tools.revoke_export.handler({ id }, context)) as {
    id: string;
    revoked: number;
  };
  expect(body).toEqual({ id, revoked: 2 });
  // The renders survive, so the next export costs one row.
  const again = payload(
    await tools.export_slideshow.handler({ id, version }, context),
  ) as { status: string };
  expect(again.status).toBe("ready");
});

/*
 * Account and library writes.
 */

type AccountBody = {
  account: { id: string; name: string; defaults: AccountDefaults };
};

type ItemBody = {
  item: { id: string; name: string; tags: string[]; url: string; description: string };
  duplicateOf?: { id: string; name: string };
};

const IMAGE_FIELDS = {
  accountId: ACCOUNT_ID,
  kind: "background" as const,
  name: "Gym floor",
  description: "An empty gym floor at dawn.",
  usage: "A calm hook slide.",
};

it("creates an account whose partial defaults inherit the built-in ones", async () => {
  const body = payload(
    await tools.create_account.handler(
      { name: "Theo", defaults: { ratio: { w: 3, h: 4 } } },
      context,
    ),
  ) as AccountBody;
  expect(body.account.name).toBe("Theo");
  expect(body.account.defaults.ratio).toEqual({ w: 3, h: 4 });
  expect(body.account.defaults.text).toEqual(BUILTIN_DEFAULTS.text);
});

it("refuses an unknown font and an out-of-range size", async () => {
  for (const text of [{ fontFamily: "Nope Sans" }, { size: 500 }]) {
    const error = await catchError(() =>
      tools.create_account.handler({ name: "Theo", defaults: { text } }, context),
    );
    expect(asHttpError(error).status).toBe(400);
  }
});

it("merges update_account over the current defaults", async () => {
  const created = payload(
    await tools.create_account.handler(
      { name: "Theo", defaults: { ratio: { w: 3, h: 4 }, text: { size: 48 } } },
      context,
    ),
  ) as AccountBody;
  const updated = payload(
    await tools.update_account.handler(
      { id: created.account.id, defaults: { text: { color: "#111111" } } },
      context,
    ),
  ) as AccountBody;
  expect(updated.account.name).toBe("Theo");
  expect(updated.account.defaults.ratio).toEqual({ w: 3, h: 4 });
  expect(updated.account.defaults.text.size).toBe(48);
  expect(updated.account.defaults.text.color).toBe("#111111");
});

it("adds an image from a data URI, with an absolute URL", async () => {
  const body = payload(
    await tools.add_library_item.handler(
      { ...IMAGE_FIELDS, data: `data:image/png;base64,${pngFixture(30, 40)}` },
      context,
    ),
  ) as ItemBody;
  expect(body.item.description).toBe(IMAGE_FIELDS.description);
  expect(body.item.url).toMatch(/^http:\/\/localhost:4173\/media\/[0-9a-f]{64}\.png$/);
  expect(body.duplicateOf).toBeUndefined();
});

it("adds an image from a URL through the fetcher", async () => {
  const fetched: string[] = [];
  const withFetcher: ToolContext = {
    ...context,
    fetchImage: (url) => {
      fetched.push(url);
      return Promise.resolve({ bytes: solidPng(20, 10), contentType: "image/png" });
    },
  };
  const body = payload(
    await tools.add_library_item.handler(
      {
        ...IMAGE_FIELDS,
        url: "https://images.example.com/gym.png",
        tags: ["Gym", "gym"],
      },
      withFetcher,
    ),
  ) as ItemBody;
  expect(fetched).toEqual(["https://images.example.com/gym.png"]);
  expect(body.item.tags).toEqual(["gym"]);
});

it("returns the existing item instead of adding the same image twice", async () => {
  const args = { ...IMAGE_FIELDS, data: pngFixture(30, 40), contentType: "image/png" };
  const first = payload(await tools.add_library_item.handler(args, context)) as ItemBody;
  const second = payload(
    await tools.add_library_item.handler({ ...args, name: "Again" }, context),
  ) as ItemBody;
  expect(second.duplicateOf).toEqual({ id: first.item.id, name: "Gym floor" });
  expect(second.item.id).toBe(first.item.id);
  expect(harness.services.library.count()).toBe(1);

  // The same bytes as an asset are a separate item, placeable as an asset.
  const asAsset = payload(
    await tools.add_library_item.handler({ ...args, kind: "asset" }, context),
  ) as ItemBody;
  expect(asAsset.duplicateOf).toBeUndefined();
  expect(harness.services.library.count()).toBe(2);
});

it("needs exactly one of url and data", async () => {
  for (const source of [
    {},
    { url: "https://example.com/a.png", data: pngFixture(2, 2) },
  ]) {
    const error = await catchError(() =>
      tools.add_library_item.handler({ ...IMAGE_FIELDS, ...source }, context),
    );
    expect(asHttpError(error).status).toBe(400);
  }
});

it("updates only the fields sent, normalising tags", async () => {
  const id = await background("Sunset");
  const body = payload(
    await tools.update_library_item.handler({ id, tags: "Hook, PROOF, hook" }, context),
  ) as ItemBody;
  expect(body.item.name).toBe("Sunset");
  expect(body.item.tags).toEqual(["hook", "proof"]);
});

it("stores layout hints, lists them, and clears them with null", async () => {
  const id = await background("Portrait");
  const layoutHints = {
    freeZone: "top" as const,
    subject: { x: 0.2, y: 0.4, w: 0.6, h: 0.3 },
  };
  await tools.update_library_item.handler({ id, layoutHints }, context);
  const listed = payload(await tools.list_library.handler({}, context)) as {
    items: { id: string; layoutHints?: unknown }[];
  };
  expect(listed.items.find((item) => item.id === id)?.layoutHints).toEqual(layoutHints);
  // A patch that leaves the hints out keeps them.
  const renamed = payload(
    await tools.update_library_item.handler({ id, name: "Face" }, context),
  ) as { item: { layoutHints?: unknown } };
  expect(renamed.item.layoutHints).toEqual(layoutHints);
  const cleared = payload(
    await tools.update_library_item.handler({ id, layoutHints: null }, context),
  ) as { item: { layoutHints?: unknown } };
  expect(cleared.item.layoutHints).toBeUndefined();
});

it("composes a middle slide into its background's free zone", async () => {
  const id = await background("Portrait");
  await tools.update_library_item.handler(
    { id, layoutHints: { freeZone: "top" } },
    context,
  );
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        ratio: { w: 9, h: 16 },
        slides: ["Hook", "Middle", "Follow"].map((text) => ({
          background: id,
          texts: [text],
        })),
      },
      context,
    ),
  ) as { id: string };
  // The fixture is square, so on a 9:16 slide the cover crop trims only its
  // sides, and the top third of the image is the top third of the slide.
  const project = harness.services.projects.require(created.id);
  const middle = project.slides[1] as { texts: { y: number; height: number }[] };
  const [text] = middle.texts;
  expect(text?.y).toBeGreaterThanOrEqual(0.07);
  expect((text?.y ?? 1) + (text?.height ?? 0)).toBeLessThanOrEqual(1 / 3 + 1e-9);
});

it("pages the library with offset, and counts every search match", async () => {
  for (const name of ["Beach one", "Beach two", "Beach three"]) await background(name);
  const list = async (args: Parameters<typeof tools.list_library.handler>[0]) =>
    payload(await tools.list_library.handler(args, context)) as {
      total: number;
      items: { id: string; url: string }[];
    };
  const first = await list({ limit: 2 });
  const rest = await list({ limit: 2, offset: 2 });
  expect(first.total).toBe(3);
  expect(first.items).toHaveLength(2);
  expect(rest.items).toHaveLength(1);
  expect(new Set([...first.items, ...rest.items].map((item) => item.id)).size).toBe(3);
  expect(first.items[0]?.url).toMatch(/^http:\/\/localhost:4173\/media\//);

  const searched = await list({ query: "beach", limit: 1 });
  expect(searched.items).toHaveLength(1);
  expect(searched.total).toBe(3);
});

/** A slideshow with one background and one line, for the copy and delete tools. */
async function draft(): Promise<{ id: string; version: number; backgroundId: string }> {
  const backgroundId = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        name: "Template",
        slides: [{ background: backgroundId, texts: ["Hook"] }],
        description: "Caption",
        hashtags: ["gym"],
      },
      context,
    ),
  ) as { id: string; version: number };
  return { ...created, backgroundId };
}

it("duplicates a slideshow into a new draft with the same document", async () => {
  const { id, backgroundId } = await draft();
  await tools.set_slideshow_status.handler({ id, status: "ready" }, context);
  const copy = payload(await tools.duplicate_slideshow.handler({ id }, context)) as {
    id: string;
    status: string;
    description: string;
    hashtags: string;
  };

  expect(copy.id).not.toBe(id);
  expect(copy.status).toBe("draft");
  expect(copy.description).toBe("Caption");
  expect(copy.hashtags).toBe("#gym");
  const source = harness.services.projects.require(id);
  const stored = harness.services.projects.require(copy.id);
  expect(stored.name).toBe("Template (copy)");
  expect(stored.slides).toEqual(source.slides);
  expect(stored.ratio).toEqual(source.ratio);
  expect(source.status).toBe("ready");
  expect(harness.services.library.require(backgroundId).stats.slideshowCount).toBe(2);
});

it("replaces the caption and name of a copy when asked", async () => {
  const { id } = await draft();
  const copy = payload(
    await tools.duplicate_slideshow.handler(
      { id, name: "Variant B", description: "", hashtags: "#legday" },
      context,
    ),
  ) as { id: string; description: string; hashtags: string };
  expect(harness.services.projects.require(copy.id).name).toBe("Variant B");
  expect(copy.description).toBe("");
  expect(copy.hashtags).toBe("#legday");
  expect(harness.services.projects.require(id).description).toBe("Caption");
});

it("keeps the composed document when update_slideshow rewrites the slides", async () => {
  const { id, version, backgroundId } = await draft();
  const composed = harness.services.projects.composedDocument(id);
  await tools.update_slideshow.handler(
    { id, version, slides: [{ background: backgroundId, texts: ["New hook"] }] },
    context,
  );
  expect(harness.services.projects.require(id).slides).not.toEqual(composed?.slides);
  expect(harness.services.projects.composedDocument(id)).toEqual(composed);
});

it("stores a copy's starting document as its composed version", async () => {
  const { id } = await draft();
  const copy = payload(await tools.duplicate_slideshow.handler({ id }, context)) as {
    id: string;
  };
  const stored = harness.services.projects.require(copy.id);
  expect(harness.services.projects.composedDocument(copy.id)).toEqual({
    ratio: stored.ratio,
    slides: stored.slides,
  });
  const read = payload(await tools.get_slideshow.handler({ id: copy.id }, context)) as {
    slideshow: { layoutChanged: number | null };
  };
  expect(read.slideshow.layoutChanged).toBe(0);
});

it("deletes a draft slideshow", async () => {
  const { id } = await draft();
  const body = payload(await tools.delete_slideshow.handler({ id }, context));
  expect(body).toEqual({ removed: id });
  expect(harness.services.projects.get(id)).toBeNull();
});

it("refuses to delete a slideshow that is not a draft", async () => {
  const { id } = await draft();
  await tools.set_slideshow_status.handler({ id, status: "ready" }, context);
  const error = asHttpError(
    await catchError(() => tools.delete_slideshow.handler({ id }, context)),
  );
  expect(error.status).toBe(409);
  expect(harness.services.projects.get(id)).not.toBeNull();
});

it("styles one line of a created slideshow and keeps the rest on the defaults", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [{ background: id, texts: [{ text: "Hook", size: 96 }, "Body"] }],
      },
      context,
    ),
  ) as { id: string; version: number };
  const [hook, body] = (
    harness.services.projects.require(created.id).slides[0] as {
      texts: { size: number }[];
    }
  ).texts;
  expect(hook?.size).toBe(96);
  expect(body?.size).toBe(context.accounts.get(ACCOUNT_ID)?.defaults.text.size);

  const updated = payload(
    await tools.update_slideshow.handler(
      {
        id: created.id,
        version: created.version,
        slides: [{ background: id, texts: [{ text: "Hook", size: 120 }, "Body"] }],
      },
      context,
    ),
  ) as { version: number };
  expect(updated.version).toBe(created.version + 1);
  const restyled = harness.services.projects.require(created.id).slides[0] as {
    texts: { size: number }[];
  };
  expect(restyled.texts[0]?.size).toBe(120);
});

it("validates a styled line before it reaches the server", () => {
  const schema = z.object(tools.create_slideshow.inputSchema);
  const slide = (text: unknown) => ({
    accountId: ACCOUNT_ID,
    slides: [{ background: "bg", texts: [text] }],
  });
  expect(schema.safeParse(slide({ text: "Hook", color: "yellow" })).success).toBe(false);
  expect(schema.safeParse(slide({ text: "Hook", size: 400 })).success).toBe(false);
  const parsed = schema.parse(slide({ text: "Hook", color: "fe0" }));
  expect(parsed.slides[0]?.texts?.[0]).toEqual({ text: "Hook", color: "#FFEE00" });
});

it("previews a one-slide slideshow as a JPEG of the requested width", async () => {
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        ratio: { w: 9, h: 16 },
        slides: [{ background: await background(), texts: ["Hello"] }],
      },
      context,
    ),
  ) as { id: string; version: number };

  const result = await tools.preview_slideshow.handler({ id: created.id }, context);

  expect(result.content).toHaveLength(2);
  const image = result.content[0];
  expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  const bytes = Buffer.from(image?.type === "image" ? image.data : "", "base64");
  expect(await sharp(bytes).metadata()).toMatchObject({
    format: "jpeg",
    width: 540,
    height: 960,
  });
  const last = result.content[1];
  expect(JSON.parse(last?.type === "text" ? last.text : "")).toEqual({
    approximate: true,
    version: created.version,
    slides: [{ slide: 1, width: 540, height: 960 }],
    warnings: [],
  });
});

it("refuses a preview of a slide the slideshow does not have", async () => {
  const created = payload(
    await tools.create_slideshow.handler(
      { accountId: ACCOUNT_ID, slides: [{ background: await background() }] },
      context,
    ),
  ) as { id: string };

  const error = asHttpError(
    await catchError(() =>
      tools.preview_slideshow.handler({ id: created.id, slides: [1, 3] }, context),
    ),
  );

  expect(error.status).toBe(400);
  expect(error.message).toContain("no slide 3");
});

it("draws a line styled bigger than the rest bigger in the preview", async () => {
  // Same text, two sizes: a bigger glyph covers more of a black background.
  const dark = (
    await harness.services.library.create({
      kind: "background",
      name: "Night",
      description: "",
      usage: "",
      tags: "",
      contentType: "image/png",
      bytes: solidPng(270, 480, [0, 0, 0]),
      accountId: ACCOUNT_ID,
    })
  ).id;
  async function inkFor(size: number): Promise<number> {
    const created = payload(
      await tools.create_slideshow.handler(
        {
          accountId: ACCOUNT_ID,
          slides: [
            { background: dark, texts: [{ text: "Hook", size, color: "#FFFFFF" }] },
          ],
        },
        context,
      ),
    ) as { id: string };
    const image = (await tools.preview_slideshow.handler({ id: created.id }, context))
      .content[0];
    const bytes = Buffer.from(image?.type === "image" ? image.data : "", "base64");
    const { data } = await sharp(bytes)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data.filter((value) => value > 128).length;
  }

  expect(await inkFor(120)).toBeGreaterThan((await inkFor(40)) * 3);
});

it("returns anchors from get_slideshow and recomposes only the slide whose anchor changed", async () => {
  const id = await background();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        accountId: ACCOUNT_ID,
        slides: [
          { background: id, texts: ["Hook"] },
          { background: id, texts: ["Body"], layout: { text: "bottom" } },
        ],
      },
      context,
    ),
  ) as { id: string; version: number };
  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { slides: { layout?: unknown }[] };
  };
  expect(read.slideshow.slides.map((slide) => slide.layout)).toEqual([
    undefined,
    { text: "bottom" },
  ]);

  const before = slidesOf(created.id);
  await tools.update_slideshow.handler(
    {
      id: created.id,
      version: created.version,
      slides: [
        { background: id, texts: ["Hook"] },
        { background: id, texts: ["Body"], layout: { text: "top" } },
      ],
    },
    context,
  );
  const after = slidesOf(created.id);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]?.texts[0]?.y).toBeLessThan(before[1]?.texts[0]?.y ?? 0);
});
