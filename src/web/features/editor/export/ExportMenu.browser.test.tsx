import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import "../../../design/fonts.css";
import { parseProject } from "@shared/schema/index.js";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { EditorStore } from "../store.js";
import { ExportMenu } from "./ExportMenu.js";
import { safeFilename, slideExportName } from "./download.js";
import { canShareFiles, shareFiles } from "./share.js";
import { libraryItem, solidImage } from "./testing.js";

/*
 * The four export buttons.
 *
 * Nothing here reaches into the component's state. A download is observed
 * through the anchor the browser is handed, and a share through the files
 * navigator.share is called with, because those are the two things the reader's
 * machine actually does.
 */

const BACKGROUND = solidImage(270, 480, "#3355aa");

afterEach(() => {
  cleanup();
});

type ProjectOptions = {
  name?: string;
  ratio?: { w: number; h: number };
  /** A text layer, so an edit between two presses changes the rendered bytes. */
  text?: boolean;
};

function projectOf(slideCount: number, options: ProjectOptions = {}): Project {
  const { name = "My Slideshow", ratio = { w: 9, h: 16 }, text = false } = options;
  return parseProject({
    id: "project-1",
    name,
    version: 1,
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ratio,
    slides: Array.from({ length: slideCount }, (_slide, index) => ({
      id: `slide-${String(index + 1)}`,
      backgroundItemId: "background",
      name: `Slide ${String(index + 1)}`,
      width: 270,
      height: 480,
      imageScale: 1,
      imageX: 0,
      imageY: 0,
      overlays: [],
      texts: text
        ? [
            {
              id: `text-${String(index + 1)}`,
              text: "before",
              x: 0.1,
              y: 0.4,
              width: 0.8,
              height: 0.2,
              size: 120,
              style: "plain",
              outlineWidth: 12,
              color: "#FFFFFF",
              background: "white",
              backgroundShape: "full",
              align: "center",
              rotation: 0,
              z: 1,
            },
          ]
        : [],
    })),
  });
}

/** The pixel size a PNG declares in its IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function libraryOf(): LibraryIndex {
  return new Map<string, LibraryItem>([
    ["background", libraryItem("background", BACKGROUND, 270, 480)],
  ]);
}

async function open(project: Project) {
  // EditorStore opens on the first slide already (store.ts:112), which is what
  // every single-slide action reads.
  const store = new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
  const screen = await render(
    <ToastProvider>
      <ExportMenu store={store} library={libraryOf()} />
    </ToastProvider>,
  );
  return { store, screen };
}

/* Every download in one place, so a test reads the anchor rather than the DOM. */
type Download = { filename: string; bytes: Uint8Array };

async function withDownloads(body: () => Promise<void>): Promise<Download[]> {
  /*
   * The blob is kept by the URL that named it rather than fetched back
   * afterwards. downloadBlob revokes on a one second timer, and rendering three
   * slides outlasts that, so a fetch after the fact reads a URL the browser has
   * already forgotten.
   */
  const blobs = new Map<string, Blob>();
  const captured: { filename: string; url: string }[] = [];
  const realCreate = URL.createObjectURL.bind(URL);
  const realClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (source: Blob | MediaSource) => {
    const url = realCreate(source);
    if (source instanceof Blob) blobs.set(url, source);
    return url;
  };
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download === "") {
      realClick.call(this);
      return;
    }
    captured.push({ filename: this.download, url: this.href });
  };
  try {
    await body();
  } finally {
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
  }
  return Promise.all(
    captured.map(async (entry) => {
      const blob = blobs.get(entry.url);
      if (blob === undefined) throw new Error(`Nothing was written to ${entry.url}.`);
      return {
        filename: entry.filename,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      };
    }),
  );
}

/** Reads the names out of an archive by walking its central directory. */
function zipNames(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  expect(view.getUint32(end, true), "the download is a ZIP").toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(cursor + 28, true);
    names.push(decoder.decode(archive.slice(cursor + 46, cursor + 46 + nameLength)));
    cursor +=
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  return names;
}

const PNG_MAGIC = [137, 80, 78, 71];

describe("downloading", () => {
  it("downloads one PNG named after the slide", async () => {
    const project = projectOf(2);
    const { screen } = await open(project);
    const button = screen.getByRole("button", { name: "Download current slide as PNG" });
    await expect.element(button).toBeEnabled();

    const downloads = await withDownloads(async () => {
      await button.click();
      // The button reports its own work, so waiting on it waits on the render.
      await expect.element(button).toBeEnabled();
      await expect
        .element(page.getByText("PNG downloaded at full resolution"))
        .toBeVisible();
    });

    expect(downloads).toHaveLength(1);
    const only = downloads[0];
    const first = project.slides[0];
    if (first === undefined) throw new Error("The fixture holds no slide.");
    expect(only?.filename).toBe("my-slideshow-slide-1.png");
    expect(only?.filename).toBe(slideExportName(first, project.name));
    expect(Array.from((only?.bytes ?? new Uint8Array()).slice(0, 4))).toEqual(PNG_MAGIC);
  });

  it("downloads a ZIP holding one PNG per slide", async () => {
    const project = projectOf(3);
    const { screen } = await open(project);
    const button = screen.getByRole("button", { name: "Download all slides as a ZIP" });
    await expect.element(button).toBeEnabled();

    const downloads = await withDownloads(async () => {
      await button.click();
      await expect.element(page.getByText("3 slides downloaded as a ZIP")).toBeVisible();
    });

    expect(downloads).toHaveLength(1);
    const archive = downloads[0];
    expect(archive?.filename).toBe("my-slideshow.zip");
    expect(zipNames(archive?.bytes ?? new Uint8Array())).toEqual([
      "01-my-slideshow-slide-1.png",
      "02-my-slideshow-slide-2.png",
      "03-my-slideshow-slide-3.png",
    ]);
  });

  it("names a file after a slideshow whose name has no letters in it", async () => {
    const project = projectOf(1, { name: "!!! ??? ***" });
    expect(safeFilename(project.name)).toBe("slide");
    const { screen } = await open(project);
    const downloads = await withDownloads(async () => {
      await screen.getByRole("button", { name: "Download current slide as PNG" }).click();
      await expect
        .element(page.getByText("PNG downloaded at full resolution"))
        .toBeVisible();
    });
    expect(downloads[0]?.filename).toBe("slide-slide-1.png");
  });

  it("renders at the slideshow's own ratio", async () => {
    // Every other fixture here is 9:16, so a menu that hard-coded 1920 would
    // pass all of them. renderSlideCanvas is covered across ratios in
    // render.browser.test.tsx; this covers the menu's wiring of one into it.
    const { screen } = await open(projectOf(1, { ratio: { w: 1, h: 1 } }));
    const downloads = await withDownloads(async () => {
      await screen.getByRole("button", { name: "Download current slide as PNG" }).click();
      await expect
        .element(page.getByText("PNG downloaded at full resolution"))
        .toBeVisible();
    });
    expect(pngSize(downloads[0]?.bytes ?? new Uint8Array())).toEqual({
      width: 1080,
      height: 1080,
    });
  });

  it("offers nothing to export while the slideshow is empty", async () => {
    const { screen } = await open(projectOf(0));
    await expect
      .element(screen.getByRole("button", { name: "Download all slides as a ZIP" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Download current slide as PNG" }))
      .toBeDisabled();
  });
});

describe("sharing", () => {
  const realCanShare = Object.getOwnPropertyDescriptor(Navigator.prototype, "canShare");
  const realShare = Object.getOwnPropertyDescriptor(Navigator.prototype, "share");

  function restoreNavigator() {
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "userActivation");
    expect(
      realCanShare === undefined || typeof navigator.canShare === "function",
      "the real canShare is back, or was never there",
    ).toBe(true);
    expect(realShare === undefined || typeof navigator.share === "function").toBe(true);
  }

  afterEach(() => {
    restoreNavigator();
  });

  it("hides the share buttons when the browser cannot share files", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => false,
    });
    const { screen } = await open(projectOf(2));
    /*
     * The positive signal is the pair of download buttons. They come from the
     * same render as the share buttons, so finding them proves the menu drew
     * and that the two AirDrop buttons are absent by choice rather than because
     * nothing rendered at all.
     */
    await expect
      .element(screen.getByRole("button", { name: "Download current slide as PNG" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Download all slides as a ZIP" }))
      .toBeVisible();
    expect(
      document.querySelectorAll('button[aria-label^="AirDrop"]'),
      "no AirDrop button is on the page",
    ).toHaveLength(0);
  });

  it("shows the share buttons when the browser can share files", async () => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    const { screen } = await open(projectOf(2));
    await expect
      .element(screen.getByRole("button", { name: "AirDrop current slide" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "AirDrop all slides" }))
      .toBeVisible();
  });

  it("shares one PNG for the slide on screen", async () => {
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.resolve();
      },
    });

    const { screen } = await open(projectOf(2));
    const button = screen.getByRole("button", { name: "AirDrop current slide" });
    await button.click();
    await expect.poll(() => shared.length).toBe(1);

    const files = shared[0]?.files ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("my-slideshow-slide-1.png");
    expect(files[0]?.type).toBe("image/png");
    expect(shared[0]?.title).toBe("My Slideshow");
  });

  it("shares every slide, and keeps the files for a second press", async () => {
    const shared: ShareData[] = [];
    let allowed = false;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        // Safari refuses the sheet once the press that started the render has
        // lapsed, which is exactly what the cache exists to survive.
        if (!allowed) {
          const refusal = new Error("gesture expired");
          refusal.name = "NotAllowedError";
          return Promise.reject(refusal);
        }
        shared.push(data);
        return Promise.resolve();
      },
    });

    const { screen } = await open(projectOf(3));
    const button = screen.getByRole("button", { name: "AirDrop all slides" });
    await button.click();
    await expect
      .element(page.getByText("Slides are ready — tap AirDrop all again."))
      .toBeVisible();

    allowed = true;
    await expect.element(button).toBeEnabled();
    await button.click();
    await expect.poll(() => shared.length).toBe(1);

    const files = shared[0]?.files ?? [];
    expect(files.map((file) => file.name)).toEqual([
      "01-my-slideshow-slide-1.png",
      "02-my-slideshow-slide-2.png",
      "03-my-slideshow-slide-3.png",
    ]);
  });

  it("holds the files back when the gesture that rendered them has lapsed", async () => {
    /*
     * The Safari rule the brief singled out. Rendering a slideshow's worth of
     * PNGs outlasts the press that started it, and Safari then refuses
     * navigator.share outright. app.js:4384 asks first so it can tell the
     * reader to press again, and the cache is what makes that second press
     * instant.
     *
     * The recovery through NotAllowedError is covered below. This is the
     * pre-emptive check, which nothing else reaches.
     */
    const shared: ShareData[] = [];
    let active = false;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      get: () => ({ isActive: active, hasBeenActive: true }),
    });

    const { screen } = await open(projectOf(3));
    const button = screen.getByRole("button", { name: "AirDrop all slides" });
    await button.click();
    await expect
      .element(page.getByText("Slides are ready — tap AirDrop all again."))
      .toBeVisible();

    active = true;
    await expect.element(button).toBeEnabled();
    await button.click();
    await expect.poll(() => shared.length).toBe(1);
    /*
     * One share, not two. A menu that skipped the activation check would have
     * opened the sheet on the first press as well, so this count is what
     * separates the two behaviours rather than an assertion that nothing
     * happened.
     */
    expect(shared).toHaveLength(1);
    expect((shared[0]?.files ?? []).map((file) => file.name)).toEqual([
      "01-my-slideshow-slide-1.png",
      "02-my-slideshow-slide-2.png",
      "03-my-slideshow-slide-3.png",
    ]);
  });

  it("renders the slides again once the document has changed under the cache", async () => {
    /*
     * app.js keyed this cache on project.updatedAt, which only moves when the
     * server answers a save, so an edit made since the last one served the
     * previous render. The key is the document itself here, and this is what
     * says so: the same button, pressed twice around one edit, has to hand over
     * different bytes the second time.
     */
    const shared: ShareData[] = [];
    let allowed = false;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        if (!allowed) {
          const refusal = new Error("gesture expired");
          refusal.name = "NotAllowedError";
          return Promise.reject(refusal);
        }
        return Promise.resolve();
      },
    });

    const { store, screen } = await open(projectOf(1, { text: true }));
    const button = screen.getByRole("button", { name: "AirDrop all slides" });
    await button.click();
    await expect.poll(() => shared.length).toBe(1);

    store.mutate((document) => {
      const text = document.slides[0]?.texts[0];
      if (text !== undefined) text.text = "after the edit";
    });

    allowed = true;
    await expect.element(button).toBeEnabled();
    await button.click();
    await expect.poll(() => shared.length).toBe(2);

    const before = shared[0]?.files?.[0];
    const after = shared[1]?.files?.[0];
    if (before === undefined || after === undefined) {
      throw new Error("Both presses have to hand over a file.");
    }
    const first = new Uint8Array(await before.arrayBuffer());
    const second = new Uint8Array(await after.arrayBuffer());
    expect(first.length, "the first press rendered something").toBeGreaterThan(100);
    expect(
      second.length === first.length &&
        second.every((byte, index) => byte === first[index]),
      "the second press must not hand over the render from before the edit",
    ).toBe(false);
  });

  it("reuses the rendered files when nothing has changed", async () => {
    // The other half of the same key. Without the cache the second press would
    // encode three more PNGs, and Safari would have lost the gesture again.
    const shared: ShareData[] = [];
    let allowed = false;
    let encodes = 0;
    const realToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement["toBlob"]>
    ) {
      encodes += 1;
      realToBlob.apply(this, args);
    };
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData) => {
        shared.push(data);
        if (!allowed) {
          const refusal = new Error("gesture expired");
          refusal.name = "NotAllowedError";
          return Promise.reject(refusal);
        }
        return Promise.resolve();
      },
    });

    try {
      const { screen } = await open(projectOf(3));
      const button = screen.getByRole("button", { name: "AirDrop all slides" });
      await button.click();
      await expect.poll(() => shared.length).toBe(1);
      const afterFirst = encodes;
      expect(afterFirst, "three slides, three PNGs").toBe(3);

      allowed = true;
      await expect.element(button).toBeEnabled();
      await button.click();
      await expect.poll(() => shared.length).toBe(2);
      expect(encodes, "the second press encoded nothing new").toBe(afterFirst);
    } finally {
      HTMLCanvasElement.prototype.toBlob = realToBlob;
    }
  });

  it("refuses to open the sheet on files the browser will not take", async () => {
    // shareFiles asks canShareFiles first so a browser saying no arrives as a
    // sentence. navigator.share rejects with a TypeError in that case, which
    // reads to a caller as a bug in the caller.
    let opened = 0;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => {
        opened += 1;
        return Promise.resolve();
      },
    });
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    expect(canShareFiles([file])).toBe(false);
    await expect(shareFiles([file], "Title")).rejects.toThrow(
      "This browser cannot share files.",
    );
    expect(opened, "the sheet was never asked for").toBe(0);
  });

  it("says so when the browser refuses a batch of files", async () => {
    let asked = 0;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      // The probe at mount says yes so the button exists, and the batch says no.
      value: (data: ShareData) => {
        asked += 1;
        return (data.files?.length ?? 0) < 2;
      },
    });
    const { screen } = await open(projectOf(3));
    await screen.getByRole("button", { name: "AirDrop all slides" }).click();
    await expect
      .element(page.getByText("This browser can’t share multiple images at once."))
      .toBeVisible();
    expect(asked, "the batch was offered to the browser").toBeGreaterThan(1);
  });
});
