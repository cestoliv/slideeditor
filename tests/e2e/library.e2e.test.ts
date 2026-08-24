import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Locator } from "vitest/browser";
import type { LibraryItem } from "@shared/schema/index.js";
import {
  baseUrl,
  createSlideshow,
  openApp,
  seedLibrary,
  solidPng,
  uniqueTag,
} from "./setup/fixtures.js";

/*
 * The library as the person who curates it meets it, and as the agent that
 * reads it does. Both talk to the same real server and the same real files on
 * the throwaway data directory.
 */

/** The library page filtered down to one item, which is the only way one card is unique. */
async function browseTo(kind: "backgrounds" | "assets", query: string): Promise<void> {
  await openApp(`/library/${kind}`);
  const search = page.getByLabelText("Search the library");
  await expect.element(search).toBeVisible();
  await userEvent.fill(search, query);
}

/**
 * The hidden picker behind the Upload button, which carries no label of its own.
 *
 * The button is awaited rather than the search box: they render together today,
 * so reading the DOM off the search box worked by coincidence rather than by
 * order. The picker is the button's sibling, so the button being on screen is
 * what makes the query below safe.
 */
async function filePicker(kind: "backgrounds" | "assets"): Promise<Locator> {
  await expect
    .element(page.getByRole("button", { name: `Upload ${kind}` }))
    .toBeVisible();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("The library page has no file picker.");
  return page.elementLocator(input);
}

it("warns which slideshows break before deleting an item in use", async () => {
  const tag = uniqueTag();
  const { backgrounds } = await seedLibrary(baseUrl, tag);
  const used = backgrounds[0]!;
  await createSlideshow(baseUrl, {
    name: `Winter guide ${tag}`,
    slides: [{ background: used.id, texts: ["Layer up"] }],
  });
  await createSlideshow(baseUrl, {
    name: `Autumn guide ${tag}`,
    slides: [{ background: used.id, texts: ["Bring a coat"] }],
  });

  await browseTo("backgrounds", tag);
  await userEvent.click(page.getByLabelText(`Delete ${used.name}`));

  // The names are the point. "It is used somewhere" leaves a person guessing
  // which of their slideshows they are about to break.
  const warning = page.getByRole("alertdialog");
  await expect.element(warning).toBeVisible();
  await expect.element(warning).toHaveTextContent(`Delete ${used.name}?`);
  await expect.element(warning).toHaveTextContent(`Autumn guide ${tag}`);
  await expect.element(warning).toHaveTextContent(`Winter guide ${tag}`);

  // Nothing was deleted by opening the warning, which is what makes it a warning.
  expect(await itemStatus(used.id)).toBe(200);

  await userEvent.click(page.getByRole("button", { name: "Delete anyway" }));
  await expect.element(page.getByText(`${used.name} deleted`)).toBeVisible();
  await expect.poll(async () => itemStatus(used.id), { timeout: 10000 }).toBe(404);
  await expect
    .element(page.getByLabelText(`Delete ${used.name}`))
    .not.toBeInTheDocument();
});

it("uploads an image and finds it by searching its usage note", async () => {
  const tag = uniqueTag();
  const note = `Use this one for rainy day posts ${tag}`;
  await openApp("/library/assets");
  await expect.element(page.getByLabelText("Search the library")).toBeVisible();

  const file = await pngFile(`Umbrella ${tag}`, 420, 260, "#4477cc");
  await userEvent.upload(await filePicker("assets"), file);

  // The card arriving is the upload landing: the grid renders what the server
  // answered with, not what was chosen.
  await userEvent.fill(page.getByLabelText("Search the library"), tag);
  const usage = page.getByLabelText("Usage · when to use it");
  await expect.element(usage).toBeVisible();
  await userEvent.fill(usage, note);
  // The field saves on blur, and the card says so once the server has answered.
  await userEvent.click(page.getByLabelText("Search the library"));
  await expect.element(page.getByText("Saved")).toBeVisible();

  await userEvent.fill(page.getByLabelText("Search the library"), "rainy day posts");
  await expect.element(page.getByLabelText("Name")).toHaveValue(`Umbrella ${tag}`);

  // The same words find it through the agent's route as well, which is the one
  // that decides what an agent can choose.
  const found = await searchLibrary(`rainy day ${tag}`);
  expect(found.items.map((item) => item.name)).toEqual([`Umbrella ${tag}`]);
  expect(found.items[0]?.usage).toBe(note);
});

it("stores identical images once", async () => {
  const tag = uniqueTag();
  const data = solidPng(240, 180, "#8a2be2");
  const first = await upload(`Twin one ${tag}`, data);
  const second = await upload(`Twin two ${tag}`, data);

  expect(first.id).not.toBe(second.id);
  expect(second.mediaId).toBe(first.mediaId);
  expect(second.url).toBe(first.url);

  // The shared file is what proves it: deleting one item must leave the other
  // one's image still served.
  const removed = await fetch(`${baseUrl}/api/library/${first.id}`, { method: "DELETE" });
  expect(removed.status).toBe(200);
  const image = await fetch(second.url);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toContain("image/png");
});

it("accepts two agents uploading the same image at the same time", async () => {
  /*
   * A regression guard over a defect this suite found. `MediaStore.put` used to
   * name its temporary file `<hash>.<pid>.tmp`, which is the same path for both
   * callers when the bytes and the process are the same: one rename landed and
   * the other found nothing to rename, so the upload answered 500.
   *
   * The unlucky interleave was worse than the visible one. The second write
   * could truncate the file the first was renaming, storing a broken image
   * under a hash asserting it was whole, and every later upload of those bytes
   * deduped onto it. No test can see that directly, which is why the unique
   * temporary name matters beyond the status code below.
   *
   * Two agents choosing the same picture at the same moment is ordinary use.
   */
  const tag = uniqueTag();
  const data = solidPng(320, 240, "#0abf53", tag);
  const post = (name: string): Promise<Response> =>
    fetch(`${baseUrl}/api/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "asset", name, contentType: "image/png", data }),
    });

  const [first, second] = await Promise.all([
    post(`Race A ${tag}`),
    post(`Race B ${tag}`),
  ]);
  expect([first.status, second.status]).toEqual([200, 200]);

  const items = await Promise.all(
    [first, second].map(async (response) => {
      const { item } = (await response.json()) as { item: LibraryItem };
      return item;
    }),
  );
  expect(items[1]?.mediaId).toBe(items[0]?.mediaId);
  const image = await fetch(items[0]!.url);
  expect(image.status).toBe(200);
  const bitmap = await createImageBitmap(await image.blob());
  expect([bitmap.width, bitmap.height]).toEqual([320, 240]);
});

it("reports the page length rather than the match count when a search is paged", async () => {
  const tag = uniqueTag();
  await seedLibrary(baseUrl, tag);

  const everything = await searchLibrary(tag);
  expect(everything.items).toHaveLength(8);
  expect(everything.total).toBe(8);

  /*
   * A known defect, carried on purpose and documented here rather than fixed.
   * `list()`'s search branch returns `rows.length` as the total
   * (src/server/services/library.ts), so a paged search tells an agent the page
   * is the whole result. An agent paging on `total` therefore stops after the
   * first page. The unpaged branch above gets it right, which is what makes the
   * disagreement visible.
   */
  const paged = await searchLibrary(tag, 3);
  expect(paged.items).toHaveLength(3);
  expect(paged.total).toBe(3);
  expect(paged.total).not.toBe(everything.total);
});

async function itemStatus(id: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/library/${encodeURIComponent(id)}`);
  return response.status;
}

async function searchLibrary(
  query: string,
  limit?: number,
): Promise<{ items: LibraryItem[]; total: number }> {
  const search = new URLSearchParams({ q: query });
  if (limit !== undefined) search.set("limit", String(limit));
  const response = await fetch(`${baseUrl}/api/library?${search.toString()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: LibraryItem[]; total: number };
}

async function upload(name: string, data: string): Promise<LibraryItem> {
  const response = await fetch(`${baseUrl}/api/library`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "asset", name, contentType: "image/png", data }),
  });
  expect(response.status).toBe(200);
  const { item } = (await response.json()) as { item: LibraryItem };
  return item;
}

/** A real PNG file, the way a picker hands one over. */
async function pngFile(
  name: string,
  width: number,
  height: number,
  color: string,
): Promise<File> {
  const blob = await (await fetch(solidPng(width, height, color))).blob();
  return new File([blob], `${name}.png`, { type: "image/png" });
}
