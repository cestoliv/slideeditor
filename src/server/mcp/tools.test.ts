import { afterEach, beforeEach, expect, it } from "vitest";
import { addItem, createTestApp, type TestApp } from "../testing.js";
import { tools, type ToolContext, type ToolResult } from "./tools.js";

let harness: TestApp;
let context: ToolContext;

beforeEach(() => {
  harness = createTestApp();
  context = {
    library: harness.services.library,
    projects: harness.services.projects,
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
  return JSON.parse(first?.text ?? "") as Record<string, unknown>;
}

async function background(name = "Sunset"): Promise<string> {
  return (await addItem(harness.services.library, "background", name)).id;
}

async function asset(name = "Arrow"): Promise<string> {
  return (await addItem(harness.services.library, "asset", name)).id;
}

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
  await tools.create_slideshow.handler({ slides: [{ background: id }] }, context);
  const result = await tools.list_library.handler({}, context);
  const body = payload(result) as { items: { stats: { timesUsed: number } }[] };
  expect(body.items[0]?.stats.timesUsed).toBe(1);
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
    "width",
    "height",
    "stats",
  ]);
});

it("reads one library item with the slideshows that use it", async () => {
  const id = await background();
  await tools.create_slideshow.handler(
    { name: "Launch", slides: [{ background: id }] },
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
    tools.create_slideshow.handler({ slides: [{ background: assetId }] }, context),
  ).rejects.toThrow(/is an asset, expected a background/);
});

it("returns the edit URL from create_slideshow", async () => {
  const id = await background();
  const body = payload(
    await tools.create_slideshow.handler(
      { name: "Launch", slides: [{ background: id, texts: ["Hello"] }] },
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
    await tools.create_slideshow.handler({ slides: [{ background: id }] }, context),
  ) as { id: string };
  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { name: string };
  };
  expect(read.slideshow.name).toBe("Agent slideshow");
});

it("refuses a slideshow with no slides", async () => {
  await expect(tools.create_slideshow.handler({ slides: [] }, context)).rejects.toThrow(
    /needs at least one slide/,
  );
});

it("reads a slideshow back as the composition the agent wrote", async () => {
  const backgroundId = await background();
  const assetId = await asset();
  const created = payload(
    await tools.create_slideshow.handler(
      {
        slides: [{ background: backgroundId, assets: [assetId], texts: ["One", "Two"] }],
      },
      context,
    ),
  ) as { id: string };

  const body = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { version: number; status: string; slides: unknown[] };
    editUrl: string;
  };
  expect(body.slideshow.status).toBe("draft");
  expect(body.slideshow.version).toBe(1);
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
    await tools.create_slideshow.handler({ slides: [{ background: id }] }, context),
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
    await tools.create_slideshow.handler({ slides: [{ background: id }] }, context),
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

it("hides published slideshows unless status is all", async () => {
  const id = await background();
  const open = payload(
    await tools.create_slideshow.handler(
      { name: "Open", slides: [{ background: id }] },
      context,
    ),
  ) as { id: string };
  const done = payload(
    await tools.create_slideshow.handler(
      { name: "Done", slides: [{ background: id }] },
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
    await tools.create_slideshow.handler({ slides: [{ background: id }] }, context),
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
    name: "list_library",
    title: "List library images",
    description:
      "List or search the background and asset libraries. Read each item's `description` (what the image shows) and `usage` (when and how to use it) to choose well. Each item also carries `stats`, a record of how often it has been used before. When several items fit the slide equally well, pick the one with the lower `stats.timesUsed`, or the older `stats.lastUsedAt`, so slideshows do not all end up looking the same. Sort by `least-used` to see the neglected ones first. Returns ids to pass to create_slideshow.",
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
      "List slideshows with their id, version, status, caption, slide count and edit URL. Published slideshows are hidden by default, because that work is already posted. Pass status to widen the list.",
  },
  {
    name: "get_slideshow",
    title: "Read a slideshow",
    description:
      "Read one slideshow as a composition: per slide, its background id, asset ids and texts. Also returns the caption: `description` and `hashtags`. Layout is deliberately not exposed. Use the returned `version` when calling update_slideshow.",
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
      "Draft a slideshow from library images and text. Each slide takes one background id, any number of asset ids and any number of text lines. Write the caption too: a slideshow exists to be posted, so `description` and `hashtags` are part of the draft rather than an afterthought. Do not attempt to set positions, sizes or styling: the server lays everything out and the human adjusts it by hand afterwards. Returns the edit URL to hand back to the user.",
  },
  {
    name: "update_slideshow",
    title: "Update a slideshow",
    description:
      "Replace a slideshow's composition. Pass the `version` you read from get_slideshow: a stale version is rejected so you cannot overwrite the human's work. Slides whose composition is unchanged keep the layout the human adjusted, and geometry is preserved for any asset or text that is still present. A caption field you leave out keeps what is stored, so editing the slides never wipes a caption the human has been working on. Send an empty string to clear one on purpose.",
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
      { slides: [{ background: id, texts: ["Hello"] }] },
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
      { ratio: { w: 4, h: 5 }, slides: [{ background: id }] },
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
      { name: "Launch", slides: [{ background: id }] },
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
      { slides: [{ background: id }], hashtags: "travel, #Travel summer" },
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
      { slides: [{ background: id }], description: "First draft", hashtags: "#travel" },
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
    { slides: [{ background: id }], description: "Listed caption", hashtags: "am" },
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
    await tools.create_slideshow.handler({ slides: [{ background: id }] }, context),
  ) as { id: string };
  const read = payload(
    await tools.get_slideshow.handler({ id: created.id }, context),
  ) as {
    slideshow: { description: string; hashtags: string };
  };
  expect(read.slideshow.description).toBe("");
  expect(read.slideshow.hashtags).toBe("");
});
