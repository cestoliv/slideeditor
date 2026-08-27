import { afterEach, vi } from "vitest";
import { page } from "vitest/browser";
import { createElement } from "react";
import { cleanup, render } from "vitest-browser-react";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { App } from "@web/App.js";
import { libraryCache } from "@web/app/useLibrary.js";
// main.tsx loads these three before the first render, so a test that skips them
// measures a layout the product never shows.
import "@web/design/fonts.css";
import "@web/design/tokens.css";
import "@web/design/reset.css";

/*
 * What every end-to-end test starts from: a library on the real server, a
 * slideshow drafted through the agent route, and the real client mounted on the
 * URL the server handed back.
 *
 * The page is served by Vitest and forwards /api, /media and /mcp to the Fastify
 * server the global setup started (vitest.config.ts). Everything below therefore
 * speaks relative URLs, and `baseUrl` is the empty string in this process.
 */

/** The origin the browser reaches the real server on. Same origin, so no prefix. */
export const baseUrl = "";

/*
 * Every test that mounts the app leaves an EventSource open on /api/events, and
 * a stream still running when the file ends holds the proxy connection and the
 * server's socket open behind it. Unmounting here closes both.
 */
afterEach(() => {
  cleanup();
});

export type SeededLibrary = {
  backgrounds: LibraryItem[];
  assets: LibraryItem[];
};

/** One slide as an agent describes it: a background id, asset ids, and strings. */
export type CompositionInput = {
  name?: string;
  background: string;
  assets?: string[];
  texts?: string[];
};

export type CreateSlideshowInput = {
  name: string;
  accountId?: string;
  ratio?: { w: number; h: number };
  slides: CompositionInput[];
  /** The caption to post with. Hashtags go in as a list or as one string. */
  description?: string;
  hashtags?: string[] | string;
};

export type CreatedSlideshow = {
  id: string;
  version: number;
  editUrl: string;
  slideCount: number;
  description: string;
  hashtags: string;
};

/**
 * A solid colour PNG of an exact size, drawn by the browser under test.
 *
 * The server measures the header itself rather than trusting the upload, so the
 * size a test asks for here is the size every later assertion can rely on.
 */
export function solidPng(
  width: number,
  height: number,
  color: string,
  mark?: string,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser has no 2d canvas.");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  if (mark !== undefined) {
    // One corner pixel, so two seedings never produce byte-identical images.
    // The library stores an image once per content hash, and two files seeding
    // in parallel with the same bytes would otherwise be one upload racing
    // itself. See the concurrent upload test in library.e2e.test.ts.
    context.fillStyle = colorFrom(mark);
    context.fillRect(0, 0, 1, 1);
  }
  return canvas.toDataURL("image/png");
}

/** A colour that depends on every character of the seed, so a tag picks its own. */
function colorFrom(seed: string): string {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return `#${(hash & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Distinguishes one seeding from the next, because they share a server. */
export function uniqueTag(): string {
  return crypto.randomUUID().slice(0, 8);
}

type LibrarySeed = {
  kind: "background" | "asset";
  name: string;
  description: string;
  usage: string;
  tags: string;
  width: number;
  height: number;
  color: string;
};

// Four of each, with the descriptions and usage notes an agent reads to choose.
// The sizes differ on purpose: an overlay's aspect comes from its item, so a
// square asset and a wide one prove different things about a ratio change.
const SEEDS: LibrarySeed[] = [
  {
    kind: "background",
    name: "Dawn beach",
    description: "A wide empty beach under a pale sunrise",
    usage: "Open a travel post with this one",
    tags: "travel, calm",
    width: 1080,
    height: 1920,
    color: "#f2c185",
  },
  {
    kind: "background",
    name: "Night market",
    description: "Lantern lit stalls after dark",
    usage: "Use for food and nightlife tips",
    tags: "food, night",
    width: 1080,
    height: 1920,
    color: "#2b1b4a",
  },
  {
    kind: "background",
    name: "Mountain pass",
    description: "A road climbing between two grey peaks",
    usage: "Use when the tip is about getting somewhere",
    tags: "travel, road",
    width: 1080,
    height: 1350,
    color: "#6d7f8c",
  },
  {
    kind: "background",
    name: "Plain paper",
    description: "An off white sheet with no detail",
    usage: "Use when the words carry the slide alone",
    tags: "plain",
    width: 1080,
    height: 1080,
    color: "#f6f4ef",
  },
  {
    kind: "asset",
    name: "Wide banner",
    description: "A long flat strip of colour",
    usage: "Sits along the top of a slide",
    tags: "banner",
    width: 600,
    height: 200,
    color: "#e0533d",
  },
  {
    kind: "asset",
    name: "Square badge",
    description: "A square stamp",
    usage: "Marks a slide as a numbered step",
    tags: "badge",
    width: 300,
    height: 300,
    color: "#1f7a4d",
  },
  {
    kind: "asset",
    name: "Tall ribbon",
    description: "A narrow upright ribbon",
    usage: "Runs down one side of a slide",
    tags: "ribbon",
    width: 200,
    height: 400,
    color: "#3d4fe0",
  },
  {
    kind: "asset",
    name: "Small dot",
    description: "A single round dot",
    usage: "Points at one detail in the photo",
    tags: "dot",
    width: 120,
    height: 120,
    color: "#111111",
  },
];

/**
 * Uploads four backgrounds and four assets and hands back what the server
 * stored. The tag rides in every name, description and usage note, because the
 * whole suite shares one library and a search has to find one seeding's items
 * rather than every run's.
 */
export async function seedLibrary(
  base: string,
  tag: string = uniqueTag(),
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<SeededLibrary> {
  const backgrounds: LibraryItem[] = [];
  const assets: LibraryItem[] = [];
  for (const seed of SEEDS) {
    const response = await fetch(`${base}/api/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: seed.kind,
        name: `${seed.name} ${tag}`,
        description: `${seed.description}, ${tag}`,
        usage: `${seed.usage}, ${tag}`,
        tags: seed.tags,
        contentType: "image/png",
        data: solidPng(seed.width, seed.height, seed.color, `${tag} ${seed.name}`),
        accountId,
      }),
    });
    if (!response.ok) {
      throw new Error(`Seeding ${seed.name} failed with ${String(response.status)}`);
    }
    const { item } = (await response.json()) as { item: LibraryItem };
    if (seed.kind === "background") backgrounds.push(item);
    else assets.push(item);
  }
  return { backgrounds, assets };
}

/** Drafts a slideshow the way an agent does, over the public HTTP route. */
export async function createSlideshow(
  base: string,
  input: CreateSlideshowInput,
): Promise<CreatedSlideshow> {
  const response = await fetch(`${base}/api/slideshows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "default", ...input }),
  });
  if (!response.ok) {
    throw new Error(`Creating ${input.name} failed with ${await response.text()}`);
  }
  return (await response.json()) as CreatedSlideshow;
}

/** The stored document, read back the way the editor reads it. */
export async function readProject(base: string, id: string): Promise<Project> {
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Reading ${id} failed with ${await response.text()}`);
  const { project } = (await response.json()) as { project: Project };
  return project;
}

/**
 * The path of an edit URL.
 *
 * The server mints an absolute URL against its own base, and in this suite the
 * page is served by Vitest rather than by Fastify, so the origin belongs to a
 * server the browser is not on. The path is the part the router resolves, and
 * it is what a test opens.
 */
export function editPath(editUrl: string): string {
  return new URL(editUrl).pathname;
}

/*
 * The screen the editor is designed for.
 *
 * Vitest's default viewport is 414x896, a phone. The editor's shell is a four
 * track grid (slide rail, asset rail, workspace, inspector) and its canvas
 * actions column keeps a fixed 153px beside the stage, so at 414px the stage
 * measures 41px across and the 234px control bar under it overflows to a
 * negative x. Nothing about that is the product failing at a size anyone uses:
 * it is this suite having run a desktop editor at a phone size by default. The
 * narrow layout is worth its own attention, and section 3 of the report says
 * so, but it is not what these flows are about.
 */
export const EDITOR_VIEWPORT = { width: 1280, height: 900 };

/**
 * Opens a URL in the real client, as a fresh page load would.
 *
 * The library cache is a module singleton that loads once, and a test file
 * shares it across every mount, so it is re-read here: without that, a
 * slideshow drafted after the first mount opens with no background to
 * resolve. `invalidate()` covers the scope the about-to-mount editor will
 * ask for, not only the unscoped one this still eagerly `refresh()`es:
 * LibraryCache now keeps one independent slot per scope rather than a
 * single one every load evicted, so an account another test in this file
 * already loaded stays cached — correctly, for the app itself — right
 * through a scoped `refresh()` this call has no way to name in advance
 * (the account belongs to whichever slideshow `path` opens, not yet known
 * here). Marking every scope as due for a fresh fetch is what makes the
 * editor's own `load()` call, once it knows its scope, actually reach the
 * network instead of a previous test's now-stale answer.
 */
export async function openApp(path: string): Promise<void> {
  cleanup();
  await page.viewport(EDITOR_VIEWPORT.width, EDITOR_VIEWPORT.height);
  window.history.pushState({}, "", path);
  libraryCache.invalidate();
  await libraryCache.refresh();
  const screen = await render(createElement(App));
  // App gates its first render on a session probe, so the container is empty
  // until that answers (the Gate in src/web/App.tsx).
  await vi.waitFor(() => {
    if (screen.container.childElementCount === 0) {
      throw new Error("the app has not rendered past its session gate");
    }
  });
}

/** What one call to `downloadBlob` handed the browser. */
export type CapturedDownload = {
  filename: string;
  blob: Blob;
};

/**
 * Captures what the app downloads, without letting the browser start one.
 *
 * Vitest's browser mode exposes no download API, so the two ends of
 * `downloadBlob` are watched instead: the object URL it mints carries the bytes
 * and the anchor it clicks carries the name. Both are restored afterwards, and
 * the anchor's click is swallowed so a headless run does not accumulate files.
 */
export function captureDownloads(): {
  downloads: CapturedDownload[];
  stop: () => void;
} {
  const downloads: CapturedDownload[] = [];
  const blobs: Blob[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  const click = HTMLAnchorElement.prototype.click;

  URL.createObjectURL = (source: Blob | MediaSource): string => {
    if (source instanceof Blob) blobs.push(source);
    return createObjectURL(source);
  };
  HTMLAnchorElement.prototype.click = function capturedClick(this: HTMLAnchorElement) {
    if (this.download === "") {
      click.call(this);
      return;
    }
    const blob = blobs.pop();
    if (blob === undefined) throw new Error("A download was clicked with no blob.");
    downloads.push({ filename: this.download, blob });
  };

  return {
    downloads,
    stop: () => {
      URL.createObjectURL = createObjectURL;
      HTMLAnchorElement.prototype.click = click;
    },
  };
}
