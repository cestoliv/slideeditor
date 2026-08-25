import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Locator } from "vitest/browser";
import type { LibraryItem, Project, TextLayer } from "@shared/schema/index.js";
import {
  EDITOR_VIEWPORT,
  baseUrl,
  createSlideshow,
  editPath,
  openApp,
  readProject,
  seedLibrary,
} from "./setup/fixtures.js";

/*
 * The editor as a person meets it: a layer dragged with the mouse, a ratio
 * changed from the menu under the stage. Every number below comes off the real
 * layout in a real Chromium, and every document assertion comes back off the
 * real server.
 */

/** A box in stage coordinates, as fractions, which is how the document stores one. */
type RelativeBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  aspect: number;
};

/** Waits for the element, then measures it. Reading a rect first would race. */
async function boxOf(locator: Locator): Promise<DOMRect> {
  await expect.element(locator).toBeVisible();
  return locator.element().getBoundingClientRect();
}

async function relativeTo(stage: Locator, layer: Locator): Promise<RelativeBox> {
  const frame = await boxOf(stage);
  const box = await boxOf(layer);
  return {
    x: (box.left - frame.left) / frame.width,
    y: (box.top - frame.top) / frame.height,
    width: box.width / frame.width,
    height: box.height / frame.height,
    aspect: box.width / box.height,
  };
}

const stage = (): Locator => page.getByTestId("stage");

it("moves a text layer and keeps the move after a reload", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Drag a line",
    ratio: { w: 4, h: 5 },
    slides: [
      {
        background: backgrounds[0]!.id,
        texts: ["Pack light", "Then pack lighter", "You will thank yourself"],
      },
    ],
  });
  const before = await readProject(baseUrl, created.id);
  await openApp(editPath(created.editUrl));

  const layer = page.getByLabelText("Text layer: Pack light");
  const frame = await boxOf(stage());
  const start = await boxOf(layer);
  const target = { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
  const travel = Math.hypot(
    target.x - (start.left + start.width / 2),
    target.y - (start.top + start.height / 2),
  );
  // A drag onto a point the layer already sits on would prove nothing, so the
  // fixture's own geometry is checked before the gesture rather than assumed.
  expect(travel).toBeGreaterThan(30);

  // Playwright presses at the source's centre and releases at the target's, so
  // the layer's centre lands on the stage's centre.
  await userEvent.dragAndDrop(layer, stage());

  const moved = await boxOf(layer);
  // The stage is measured again rather than reused from before the gesture.
  // The assertion is about where the layer sits inside the stage, so a stage
  // that shifted underneath (a scrollbar appearing, a font swapping, the
  // window differing from the viewport asked for) would otherwise be read as
  // the drag having missed.
  const frameAfter = await boxOf(stage());
  const centre = {
    x: frameAfter.left + frameAfter.width / 2,
    y: frameAfter.top + frameAfter.height / 2,
  };
  // Two pixels, because the browser dispatches the press and the release on
  // whole device pixels while the layer's centre sits wherever the layout put
  // it. The travel asserted above is a hundred times that, so the tolerance
  // cannot swallow a drag that went nowhere or went somewhere else.
  //
  // The message carries the geometry: a bare "expected 5.49 to be less than 2"
  // says a drag missed but not whether the layer or the stage was the thing
  // that moved, and this only reproduces on some machines.
  const where =
    `stage before ${JSON.stringify(frame)} after ${JSON.stringify(frameAfter)}; ` +
    `layer start ${JSON.stringify(start)} moved ${JSON.stringify(moved)}; ` +
    `window ${String(window.innerWidth)}x${String(window.innerHeight)} ` +
    `documentElement ${String(document.documentElement.clientWidth)}x${String(document.documentElement.clientHeight)}`;
  expect(Math.abs(moved.left + moved.width / 2 - centre.x), where).toBeLessThan(2);
  expect(Math.abs(moved.top + moved.height / 2 - centre.y), where).toBeLessThan(2);

  // The move is only real once the server holds it. Polling the document is the
  // signal the save landed, which no wait on the clock could stand in for.
  await expect
    .poll(async () => (await readProject(baseUrl, created.id)).version, {
      timeout: 10000,
    })
    .toBeGreaterThan(before.version);

  const stored = await readProject(baseUrl, created.id);
  const storedLayer = textNamed(stored, "Pack light");
  const original = textNamed(before, "Pack light");
  /*
   * The stored coordinates are fractions of the slide, so the gesture's travel
   * in pixels predicts them exactly. Checking the predicted pair rather than
   * "something changed" is what makes this fail on a drag that moves the wrong
   * axis or scales the delta wrongly.
   *
   * A composed text box spans the slide's width, so its centre already sits on
   * the stage's centre line and dx is near zero. dy carries the gesture, and it
   * is asserted to be a real distance below.
   */
  const dx = (target.x - (start.left + start.width / 2)) / frame.width;
  const dy = (target.y - (start.top + start.height / 2)) / frame.height;
  expect(Math.abs(dy)).toBeGreaterThan(0.05);
  expect(storedLayer.x).toBeCloseTo(original.x + dx, 2);
  expect(storedLayer.y).toBeCloseTo(original.y + dy, 2);

  // A fresh page load, which is the only proof the move outlived this tab.
  await openApp(editPath(created.editUrl));
  const reloaded = page.getByLabelText("Text layer: Pack light");
  const after = await relativeTo(stage(), reloaded);
  const beforeReload = {
    x: (moved.left - frame.left) / frame.width,
    y: (moved.top - frame.top) / frame.height,
  };
  expect(after.x).toBeCloseTo(beforeReload.x, 2);
  expect(after.y).toBeCloseTo(beforeReload.y, 2);
});

it("keeps every layer's relative position when the ratio changes", async () => {
  const { backgrounds, assets } = await seedLibrary(baseUrl);
  const banner = assets[0]!;
  const ribbon = assets[2]!;
  const created = await createSlideshow(baseUrl, {
    name: "Ratio move",
    ratio: { w: 9, h: 16 },
    slides: [
      {
        background: backgrounds[0]!.id,
        assets: [banner.id, ribbon.id],
        texts: ["Three ways to save"],
      },
    ],
  });
  await openApp(editPath(created.editUrl));

  const text = page.getByLabelText("Text layer: Three ways to save");
  const bannerLayer = page.getByLabelText(`Photo overlay: ${banner.name}`);
  const ribbonLayer = page.getByLabelText(`Photo overlay: ${ribbon.name}`);

  const beforeText = await relativeTo(stage(), text);
  const beforeBanner = await relativeTo(stage(), bannerLayer);
  const beforeRibbon = await relativeTo(stage(), ribbonLayer);
  // The promise in the README: an overlay shows the asset's own shape.
  expectAspect(beforeBanner, banner);
  expectAspect(beforeRibbon, ribbon);

  const trigger = page.getByLabelText("Change the slide ratio");
  await expect.element(trigger).toHaveTextContent("9:16");
  /*
   * The one thing pinning the viewport this suite claims to run at.
   *
   * At Vitest's default 414x896 the shell's four tracks leave the stage 41px
   * wide and this control sits at a negative x, off the screen, where nothing
   * can ever click it. That surfaced once as a thirty second timeout on an
   * unrelated locator, which is an expensive way to learn it. Asserting it here
   * turns the next grid change into one named failure.
   */
  expect(window.innerWidth).toBe(EDITOR_VIEWPORT.width);
  expect((await boxOf(trigger)).left).toBeGreaterThanOrEqual(0);
  await userEvent.click(trigger);
  await userEvent.click(page.getByLabelText("4:5, Instagram portrait"));
  // The trigger names the ratio and the export size, so it is the signal the
  // change was applied rather than merely clicked.
  await expect
    .element(page.getByLabelText("Change the slide ratio"))
    .toHaveTextContent("1080 × 1350 · 4:5");

  const afterText = await relativeTo(stage(), text);
  const afterBanner = await relativeTo(stage(), bannerLayer);
  const afterRibbon = await relativeTo(stage(), ribbonLayer);

  for (const [was, now] of [
    [beforeText, afterText],
    [beforeBanner, afterBanner],
    [beforeRibbon, afterRibbon],
  ] as const) {
    expect(now.x).toBeCloseTo(was.x, 2);
    expect(now.y).toBeCloseTo(was.y, 2);
    expect(now.width).toBeCloseTo(was.width, 2);
  }
  // The stage really did change shape, so the fractions above were re-measured
  // against a different frame rather than an unchanged one.
  const frame = await boxOf(stage());
  expect(frame.width / frame.height).toBeCloseTo(1080 / 1350, 2);

  expectAspect(afterBanner, banner);
  expectAspect(afterRibbon, ribbon);

  // The new ratio reaches the server too. Waiting for it also keeps the save
  // from racing the server's shutdown once the file finishes.
  await expect
    .poll(async () => (await readProject(baseUrl, created.id)).ratio, { timeout: 10000 })
    .toEqual({ w: 4, h: 5 });
});

/** An overlay is drawn in the asset's own proportions, never stretched to fit. */
function expectAspect(box: RelativeBox, item: LibraryItem): void {
  expect(box.aspect).toBeCloseTo(item.width / item.height, 1);
}

function textNamed(project: Project, text: string): TextLayer {
  for (const slide of project.slides) {
    const found = slide.texts.find((layer) => layer.text === text);
    if (found !== undefined) return found;
  }
  throw new Error(`The document holds no text reading "${text}".`);
}

it("undoes and redoes an edit", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "History walk",
    ratio: { w: 4, h: 5 },
    slides: [
      { background: backgrounds[0]!.id, texts: ["Keep this line", "Delete this line"] },
    ],
  });
  await openApp(editPath(created.editUrl));

  const doomed = page.getByLabelText("Text layer: Delete this line");
  await userEvent.click(doomed);
  await userEvent.keyboard("{Delete}");
  await expect.element(doomed).not.toBeInTheDocument();
  await expect
    .poll(async () => storedTexts(await readProject(baseUrl, created.id)), {
      timeout: 10000,
    })
    .toEqual(["Keep this line"]);

  // app.js:4862 took Control or Meta, so both are pressed, one step at a time.
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(doomed).toBeVisible();

  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect.element(doomed).not.toBeInTheDocument();

  await userEvent.keyboard("{Meta>}z{/Meta}");
  await expect.element(doomed).toBeVisible();

  // The walk through the history is only real if the server holds where it
  // ended, and if a fresh page load finds it there.
  await expect
    .poll(async () => storedTexts(await readProject(baseUrl, created.id)), {
      timeout: 10000,
    })
    .toEqual(["Keep this line", "Delete this line"]);
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText("Text layer: Keep this line")).toBeVisible();
  await expect.element(page.getByLabelText("Text layer: Delete this line")).toBeVisible();
});

function storedTexts(project: Project): string[] {
  return project.slides.flatMap((slide) => slide.texts.map((text) => text.text));
}

it("reorders slides by dragging in the rail", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Rail order",
    ratio: { w: 4, h: 5 },
    slides: [
      { background: backgrounds[0]!.id, texts: ["Opening"] },
      { background: backgrounds[1]!.id, texts: ["Middle"] },
      { background: backgrounds[2]!.id, texts: ["Closing"] },
    ],
  });
  const before = await readProject(baseUrl, created.id);
  const originalOrder = before.slides.map((slide) => slide.id);
  const first = originalOrder[0]!;
  const second = originalOrder[1]!;
  await openApp(editPath(created.editUrl));

  const opener = (index: number): Locator =>
    page.getByLabelText(`Open slide ${String(index)}`);
  await expect.element(opener(1)).toBeVisible();
  await userEvent.dragAndDrop(opener(1), opener(3));

  /*
   * The rail drops before or after the slide under the pointer depending on
   * which half it lands in, and a release on the exact middle is one pixel from
   * either. Both readings move the first slide past the second, so that is what
   * is asserted: a reorder that did nothing leaves it where it was.
   */
  await expect
    .poll(async () => (await readProject(baseUrl, created.id)).slides.map((s) => s.id), {
      timeout: 10000,
    })
    .not.toEqual(originalOrder);

  const reordered = await readProject(baseUrl, created.id);
  const order = reordered.slides.map((slide) => slide.id);
  expect(order[0]).toBe(second);
  expect(order.indexOf(first)).toBeGreaterThan(0);
  expect([...order].sort()).toEqual([...originalOrder].sort());

  // The rail shows the new order after a fresh load, numbered from the top.
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText("Open slide 1")).toBeVisible();
  await expect.element(page.getByLabelText("Text layer: Middle")).toBeVisible();
});

it("adds an asset by dragging it from the rail onto the slide", async () => {
  const { backgrounds, assets } = await seedLibrary(baseUrl);
  const badge = assets[1]!;
  const created = await createSlideshow(baseUrl, {
    name: "Rail drop",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[3]!.id, texts: ["Step one"] }],
  });
  const before = await readProject(baseUrl, created.id);
  expect(before.slides[0]?.overlays).toHaveLength(0);
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText("Text layer: Step one")).toBeVisible();

  // The rail opens on the slideshow's own assets, and this slide has none, so
  // the library scope is where a person goes to find one.
  await userEvent.click(page.getByRole("button", { name: "Library" }));
  await userEvent.fill(page.getByLabelText("Search the asset library"), badge.name);
  const thumbnail = page.getByRole("img", { name: badge.name });
  await expect.element(thumbnail).toBeVisible();
  // The thumbnail itself carries draggable={false}; the card around it is the
  // drag source, and it is what a person's pointer actually lands on.
  const card = thumbnail.element().parentElement;
  if (card === null) throw new Error("The rail thumbnail has no draggable card.");

  // Chromium's own drag and drop, driven by the browser: the rail's onDragStart
  // and the stage's drop handler both run for real, and no DataTransfer is
  // synthesised.
  await userEvent.dragAndDrop(page.elementLocator(card), stage());

  await expect
    .poll(
      async () =>
        (await readProject(baseUrl, created.id)).slides[0]?.overlays.map(
          (overlay) => overlay.itemId,
        ),
      { timeout: 10000 },
    )
    .toEqual([badge.id]);

  const placed = page.getByLabelText(`Photo overlay: ${badge.name}`);
  await expect.element(placed).toBeVisible();
  // Dropped, not stretched: the overlay wears the asset's own proportions.
  const box = await relativeTo(stage(), placed);
  expectAspect(box, badge);

  // It survives the reload, which is what makes it placed rather than previewed.
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText(`Photo overlay: ${badge.name}`)).toBeVisible();
});
