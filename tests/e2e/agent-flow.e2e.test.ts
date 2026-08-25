import { beforeAll, expect, inject, it, vi } from "vitest";
import type { Overlay } from "@shared/schema/index.js";
import "./provided.js";
import { page, userEvent } from "vitest/browser";
import type { LibraryItem } from "@shared/schema/index.js";
import type { CreatedSlideshow } from "./setup/fixtures.js";
import {
  baseUrl,
  createSlideshow,
  editPath,
  openApp,
  readProject,
  seedLibrary,
  solidPng,
  uniqueTag,
} from "./setup/fixtures.js";

/*
 * The first promise the product makes: an agent drafts a slideshow over HTTP,
 * hands a person the edit URL, and the person opens it to find what was asked
 * for. Everything here runs against the real Fastify server the global setup
 * started, on a throwaway data directory.
 */

it("drafts a slideshow an agent asked for and opens its edit URL", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Summer travel tips",
    ratio: { w: 4, h: 5 },
    slides: [
      {
        background: backgrounds[0]!.id,
        assets: [],
        texts: ["Booking a summer trip?", "Five things to know first"],
      },
      { background: backgrounds[1]!.id, assets: [], texts: ["1. Prices peak in July"] },
    ],
  });

  /*
   * The edit URL is the whole point of the answer, so the whole of it is
   * asserted: origin and path, against the origin the global setup handed over.
   * Asserting the path alone let the suite pass while the server minted URLs
   * for port 4173, which nothing here serves.
   *
   * Opening it is a separate matter. The page is served by Vitest rather than by
   * Fastify, so the path is what this browser can resolve, and navigating to
   * another origin would cut the frame off from the runner.
   */
  expect(created.editUrl).toBe(`${inject("e2eOrigin")}/projects/${created.id}`);
  expect(editPath(created.editUrl)).toBe(`/projects/${created.id}`);
  expect(created.slideCount).toBe(2);

  await openApp(editPath(created.editUrl));

  await expect
    .element(page.getByLabelText("Text layer: Booking a summer trip?"))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Text layer: Five things to know first"))
    .toBeVisible();
  // The name reaches the page too, and it is what the person renamed field holds.
  await expect
    .element(page.getByLabelText("Slideshow name"))
    .toHaveValue("Summer travel tips");

  // The second slide's text belongs to the second slide, so opening it is how a
  // person meets it. Asserting both on one screen would assert the wrong thing.
  await userEvent.click(page.getByLabelText("Open slide 2"));
  await expect
    .element(page.getByLabelText("Text layer: 1. Prices peak in July"))
    .toBeVisible();
});

it("shows the library's usage stats to an agent that lists it", async () => {
  const tag = uniqueTag();
  const { backgrounds, assets } = await seedLibrary(baseUrl, tag);
  const chosen = backgrounds[2]!;
  const badge = assets[1]!;

  const before = await findItem(chosen.id);
  expect(before.stats).toMatchObject({ timesUsed: 0, slideshowCount: 0 });

  await createSlideshow(baseUrl, {
    name: `Stats check ${tag}`,
    slides: [
      { background: chosen.id, assets: [badge.id], texts: ["One"] },
      // The same background twice on one slideshow: timesUsed counts placements
      // and slideshowCount counts slideshows, so the two must diverge here.
      { background: chosen.id, assets: [], texts: ["Two"] },
    ],
  });

  const after = await findItem(chosen.id);
  expect(after.stats.timesUsed).toBe(2);
  expect(after.stats.slideshowCount).toBe(1);
  expect(after.stats.lastUsedAt).not.toBeNull();

  const usedBadge = await findItem(badge.id);
  expect(usedBadge.stats.timesUsed).toBe(1);
});

/** Reads one item back through the list route an agent calls. */
async function findItem(id: string): Promise<LibraryItem> {
  const response = await fetch(`${baseUrl}/api/library/${encodeURIComponent(id)}`);
  expect(response.status).toBe(200);
  const { item } = (await response.json()) as { item: LibraryItem };
  return item;
}

/*
 * A defect carried on purpose, and a tripwire rather than a characterisation.
 *
 * `layoutAssets` subtracts its gaps from the asset band with no floor, so once
 * the rows outgrow the band every overlay on the slide comes out with a
 * negative width and height and simply does not render. Ten assets and an
 * overflowing text block is enough. Task 6's report has the arithmetic; this is
 * the first place a person meets it, and an agent asking for a busy slide gets
 * a slide with no photos on it.
 *
 * The building happens in a hook rather than in the test body. Inside an
 * `it.fails` every failure counts as the expected one, so a broken upload route
 * or a rejected composition would keep this green while proving nothing. A hook
 * that throws fails the file out loud.
 */
let crowded: CreatedSlideshow | null = null;

beforeAll(async () => {
  const tag = uniqueTag();
  const { backgrounds } = await seedLibrary(baseUrl, tag);
  const badge = solidPng(400, 200, "#cc3300", tag);
  const ids: string[] = [];
  // Ten rows is the cheap trigger. Without the overflowing text it takes 93.
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${baseUrl}/api/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "asset",
        name: `Crowd ${String(index)} ${tag}`,
        contentType: "image/png",
        data: badge,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Uploading crowd asset ${String(index)} failed with ${String(response.status)}`,
      );
    }
    const { item } = (await response.json()) as { item: { id: string } };
    ids.push(item.id);
  }

  crowded = await createSlideshow(baseUrl, {
    name: `Crowded slide ${tag}`,
    ratio: { w: 9, h: 16 },
    slides: [
      {
        background: backgrounds[0]!.id,
        assets: ids,
        texts: Array.from(
          { length: 40 },
          (_unused, index) =>
            `${String(index)} A long line that wraps a great many times before it fits the content width`,
        ),
      },
    ],
  });
});

it("hands the person the caption an agent drafted, ready to copy", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Summer travel tips",
    slides: [{ background: backgrounds[0]!.id, assets: [], texts: ["Booking a trip?"] }],
    description: "Five things to know before you book a summer trip.",
    // A list going in, one string coming back, all the way through the stack.
    hashtags: ["travel", "#Summer", "travel"],
  });
  expect(created.hashtags).toBe("#travel #Summer");

  await openApp(editPath(created.editUrl));

  await userEvent.click(page.getByRole("button", { name: "Caption" }));
  await expect
    .element(page.getByLabelText("Description"))
    .toHaveValue("Five things to know before you book a summer trip.");
  await expect.element(page.getByLabelText("Hashtags")).toHaveValue("#travel #Summer");

  // The person adjusts it the way they adjust the layout, and it saves.
  await userEvent.fill(page.getByLabelText("Description"), "Six things, actually.");
  await vi.waitFor(async () => {
    const project = await readProject(baseUrl, created.id);
    expect(project.description).toBe("Six things, actually.");
    expect(project.hashtags, "the tags ride along untouched").toBe("#travel #Summer");
  });
});

/*
 * `it.fails` rather than an assertion on the values. The magnitudes are
 * deliberately uncharacterised, because any real fix has to change them and a
 * test holding them would read as the regression. A positive width and height
 * is the one thing every candidate fix satisfies and none of them changes, so
 * this documents the defect without pinning the geometry, and it turns red the
 * day someone fixes it. Delete the `.fails` then.
 */
it.fails("gives an overlay a real size when a slide carries many assets", async () => {
  if (crowded === null) throw new Error("The crowded slideshow was not built.");
  const project = await readProject(baseUrl, crowded.id);
  const overlays: Overlay[] = project.slides[0]?.overlays ?? [];
  expect(overlays).toHaveLength(10);
  for (const [index, overlay] of overlays.entries()) {
    expect(overlay.width, `overlay ${String(index)} width`).toBeGreaterThan(0);
    expect(overlay.height ?? 0, `overlay ${String(index)} height`).toBeGreaterThan(0);
  }
});
