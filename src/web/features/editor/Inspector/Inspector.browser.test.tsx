import { afterAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { page, userEvent } from "vitest/browser";
// The panel is laid out from the token layer, so the tests load it as the app does.
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { LibraryItem, Project, TextLayer } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { ToastProvider } from "../../../design/index.js";
import { Editor } from "../Editor.js";
import { EditorStore } from "../store.js";
import { fixtureProject } from "../testing.js";
import { Inspector } from "./Inspector.js";
import { fontSizeFromSliderPosition, sliderPositionFromFontSize } from "./fontSize.js";

function storeFor(project: Project): EditorStore {
  return new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
}

function asset(id: string, name: string): LibraryItem {
  return {
    id,
    kind: "background",
    name,
    description: "",
    usage: "",
    tags: [],
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width: 1080,
    height: 1920,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

/*
 * Files share one page, so a viewport left behind here reaches the next one.
 * The size found on arrival is put back on the way out.
 */
const inherited = { width: window.innerWidth, height: window.innerHeight };

afterAll(async () => {
  await page.viewport(inherited.width, inherited.height);
});

const LIBRARY: LibraryIndex = new Map([["item-1", asset("item-1", "Sunrise.png")]]);

/*
 * A desktop viewport, because below 780px the panel is a sheet the header's
 * toggle raises rather than a column that is always there. The tests below are
 * about the controls, and the sheet has its own test at the bottom.
 */
async function mount(store: EditorStore, options: { photoAdjust?: boolean } = {}) {
  await page.viewport(1280, 900);
  return render(
    <div style={{ width: "320px" }}>
      <Inspector
        store={store}
        library={LIBRARY}
        photoAdjust={options.photoAdjust ?? false}
      />
    </div>,
  );
}

/** The live text the store is mutating in place. */
function liveText(store: EditorStore): TextLayer {
  const text = store.getSnapshot().project.slides[0]?.texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  return text;
}

/*
 * Writes a value into a controlled input the way a keystroke does. userEvent
 * spends real milliseconds per character, and several of the tests below need
 * to count the writes a gesture makes rather than how long it took.
 */
function type_(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function input(label: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (element === null) throw new Error(`No input labelled ${label}.`);
  return element;
}

it("shows the text controls when a text layer is selected", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);

  await expect
    .element(screen.getByRole("heading", { name: "Text settings" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: /Words|Type something/ }))
    .toBeVisible();
  await expect.element(screen.getByRole("slider", { name: "Font size" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "Text alignment" }))
    .toBeVisible();
  screen.unmount();
});

it("shows the overlay controls when an overlay is selected", async () => {
  const store = storeFor(fixtureProject({ texts: 1, overlays: 1 }));
  store.selectOnly("overlay", "overlay-1-1");
  const screen = await mount(store);

  await expect.element(screen.getByRole("heading", { name: "Overlay" })).toBeVisible();
  await expect.element(screen.getByText("Sunrise.png")).toBeVisible();
  await expect
    .element(screen.getByRole("slider", { name: "Rotation in degrees" }))
    .toBeVisible();
  // The text controls belong to the other arm and must not leak into this one.
  expect(document.querySelector('[aria-label="Text alignment"]')).toBeNull();
  screen.unmount();
});

it("shows the photo controls while the photo is being placed", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  const screen = await mount(store, { photoAdjust: true });

  await expect
    .element(screen.getByRole("heading", { name: "Photo settings" }))
    .toBeVisible();
  await expect.element(screen.getByRole("slider", { name: "Photo zoom" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset photo" })).toBeVisible();
  screen.unmount();
});

/*
 * app.js:2061 shows the empty state when nothing is selected, not the slide's
 * own controls: photo settings live behind Adjust photo (app.js:1946). The
 * brief asked for "the slide controls when nothing is selected", which the
 * running code has never done.
 */
it("shows the empty state when nothing is selected", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  const screen = await mount(store);

  await expect.element(screen.getByRole("heading", { name: "Text" })).toBeVisible();
  await expect
    .element(screen.getByText("Select text or an overlay, or add one to this photo."))
    .toBeVisible();
  expect(document.querySelector('[aria-label="Font size"]')).toBeNull();
  screen.unmount();
});

it("changes the text colour from a preset", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  expect(liveText(store).color).toBe("#FFFFFF");

  await userEvent.click(screen.getByRole("button", { name: "Use Pink text" }));

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#FE2C55");
  });
  await expect
    .element(screen.getByRole("button", { name: "Use Pink text" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Use White text" }))
    .toHaveAttribute("aria-pressed", "false");
  screen.unmount();
});

it("changes the text colour from the wheel and shows hex and rgb", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Choose a custom text color")).toBeVisible();

  type_(input("Choose a custom text color"), "#4d7cfe");

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#4D7CFE");
  });
  await expect
    .element(screen.getByLabelText("Text color hex value"))
    .toHaveValue("#4D7CFE");
  await expect
    .element(screen.getByLabelText("Text color RGB value"))
    .toHaveValue("rgb(77, 124, 254)");
  screen.unmount();
});

it("reads a colour back from the rgb box", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Text color RGB value")).toBeVisible();

  type_(input("Text color RGB value"), "rgb(53, 208, 127)");

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#35D07F");
  });
  await expect
    .element(screen.getByLabelText("Text color hex value"))
    .toHaveValue("#35D07F");
  screen.unmount();
});

/*
 * The wheel fires once per pixel of drag, so app.js:2402-2412 opened one undo
 * entry for the whole gesture and left it open until the gesture ended. The
 * wheel asks for an entry on every one of the three writes below; if each ask
 * opened one, a single undo would land on the second colour rather than on the
 * one the layer started with.
 */
it("keeps one colour gesture on one undo entry", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Choose a custom text color")).toBeVisible();

  const wheel = input("Choose a custom text color");
  for (const value of ["#111111", "#ffe45e", "#a855f7"]) {
    type_(wheel, value);
    await vi.waitFor(() => {
      expect(liveText(store).color).toBe(value.toUpperCase());
    });
  }

  store.undo();
  expect(liveText(store).color).toBe("#FFFFFF");
  screen.unmount();
});

it("switches between plain, outline, and boxed", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Outline" }));
  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("outline");
  });
  await expect
    .element(screen.getByRole("button", { name: "Outline" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "Box" }));
  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("boxed");
  });
  // The box's own controls only exist for a boxed layer (app.js:2040).
  await expect.element(screen.getByRole("group", { name: "Box shape" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Clean" }));
  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("plain");
  });
  expect(document.querySelector('[aria-label="Box shape"]')).toBeNull();
  screen.unmount();
});

/*
 * ensureBoxedTextContrast, app.js:2328 and app.js:2436.
 *
 * A white text turned into a white box is a white shape with nothing on it, so
 * the colour moves rather than the box. The flip belongs to the two controls
 * that can inflict the collision without the author choosing it: becoming
 * boxed, and switching the pill's tone. Task 4 owns the rule; this only calls it.
 *
 * All four combinations are covered across the two commit points. The two that
 * are already legible have to come through untouched, or the rule would be
 * repainting colours nobody asked it to.
 */
function storeWithText(fields: Partial<TextLayer>): EditorStore {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) Object.assign(text, fields);
  });
  store.selectOnly("text", "text-1-1");
  return store;
}

it("flips white text off a white pill when a layer becomes boxed", async () => {
  const store = storeWithText({ style: "plain", background: "white", color: "#FFFFFF" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Box" }));

  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("boxed");
  });
  expect(liveText(store).color).toBe("#111111");
  screen.unmount();
});

it("leaves white text on a black pill alone when a layer becomes boxed", async () => {
  const store = storeWithText({ style: "plain", background: "black", color: "#FFFFFF" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Box" }));

  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("boxed");
  });
  expect(liveText(store).color).toBe("#FFFFFF");
  screen.unmount();
});

it("leaves dark text on a white pill alone when a layer becomes boxed", async () => {
  const store = storeWithText({ style: "plain", background: "white", color: "#111111" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Box" }));

  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("boxed");
  });
  expect(liveText(store).color).toBe("#111111");
  screen.unmount();
});

it("flips dark text off a pill that has just turned black", async () => {
  const store = storeWithText({ style: "boxed", background: "white", color: "#111111" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Black background" }));

  await vi.waitFor(() => {
    expect(liveText(store).background).toBe("black");
  });
  expect(liveText(store).color).toBe("#FFFFFF");
  screen.unmount();
});

it("flips white text off a pill that has just turned white", async () => {
  const store = storeWithText({ style: "boxed", background: "black", color: "#FFFFFF" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "White background" }));

  await vi.waitFor(() => {
    expect(liveText(store).background).toBe("white");
  });
  expect(liveText(store).color).toBe("#111111");
  screen.unmount();
});

/*
 * The rule reads a layer's own style, so a text that is no longer boxed has no
 * pill to collide with and keeps whatever colour it had. Without this the flip
 * would be free to repaint plain and outline layers too.
 */
it("leaves a layer's colour alone when it stops being boxed", async () => {
  const store = storeWithText({ style: "boxed", background: "white", color: "#111111" });
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Clean" }));

  await vi.waitFor(() => {
    expect(liveText(store).style).toBe("plain");
  });
  expect(liveText(store).color).toBe("#111111");
  screen.unmount();
});

/*
 * The hex box holds what was typed, not what is stored, so a colour halfway to
 * being typed stays on screen (app.js:2413-2415). Twenty-five lines of
 * ColorPicker exist for this and nothing drove them: replacing both drafts with
 * the stored value left every other test green while making a colour impossible
 * to hand-type, because the first keystroke re-rendered the box under the caret.
 *
 * This also pins the six-digit rule, which is the mechanism the decision below
 * rests on. "#A85" is a valid three-digit colour and expands to #AA8855, so a
 * commit rule that accepted three digits would write a colour the author never
 * finished asking for.
 */
it("keeps a half-typed colour on screen and commits only on the sixth digit", async () => {
  const store = storeWithText({ style: "plain", background: "white", color: "#FFFFFF" });
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Text color hex value")).toBeVisible();

  const hex = input("Text color hex value");
  hex.focus();
  for (const partial of ["#", "#A", "#A8", "#A85", "#A855", "#A855F"]) {
    type_(hex, partial);
    // The draft survives, and nothing has been written to the layer yet.
    await expect
      .element(screen.getByLabelText("Text color hex value"))
      .toHaveValue(partial);
    expect(liveText(store).color).toBe("#FFFFFF");
  }

  type_(hex, "#A855F7");

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#A855F7");
  });
  // The sibling box follows, which is the other half of what the drafts are for.
  await expect
    .element(screen.getByLabelText("Text color RGB value"))
    .toHaveValue("rgb(168, 85, 247)");
  screen.unmount();
});

/* The RGB box holds a draft for the same reason, and commits on three channels. */
it("keeps a half-typed rgb value on screen", async () => {
  const store = storeWithText({ style: "plain", background: "white", color: "#FFFFFF" });
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Text color RGB value")).toBeVisible();

  const rgb = input("Text color RGB value");
  rgb.focus();
  type_(rgb, "rgb(168, 85");

  await expect
    .element(screen.getByLabelText("Text color RGB value"))
    .toHaveValue("rgb(168, 85");
  expect(liveText(store).color).toBe("#FFFFFF");

  type_(rgb, "rgb(168, 85, 247)");

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#A855F7");
  });
  screen.unmount();
});

/*
 * The colour picker deliberately does not flip. setTextColor (app.js:2378-2392)
 * writes the colour and calls nothing else, and that is the right split: the
 * two controls above can make a layer invisible without the author choosing it,
 * where picking a colour is the author choosing it. Flipping here would also
 * make white unreachable on a white pill, because the hex box commits on the
 * sixth digit and would rewrite itself mid-word.
 */
it("does not overrule a colour the author picked", async () => {
  const store = storeWithText({ style: "boxed", background: "white", color: "#111111" });
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Text color hex value")).toBeVisible();

  type_(input("Text color hex value"), "#FFFFFF");

  await vi.waitFor(() => {
    expect(liveText(store).color).toBe("#FFFFFF");
  });
  expect(liveText(store).background).toBe("white");
  screen.unmount();
});

it("switches a boxed layer between per-line and full background", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) text.style = "boxed";
  });
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  expect(liveText(store).backgroundShape).toBe("full");

  await userEvent.click(screen.getByRole("button", { name: "Per line" }));
  await vi.waitFor(() => {
    expect(liveText(store).backgroundShape).toBe("lines");
  });
  await expect
    .element(screen.getByRole("button", { name: "Full box" }))
    .toHaveAttribute("aria-pressed", "false");

  await userEvent.click(screen.getByRole("button", { name: "Full box" }));
  await vi.waitFor(() => {
    expect(liveText(store).backgroundShape).toBe("full");
  });
  screen.unmount();
});

it("switches a boxed layer between a white and a black background", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) text.style = "boxed";
  });
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Black background" }));

  await vi.waitFor(() => {
    expect(liveText(store).background).toBe("black");
  });
  screen.unmount();
});

it("changes the alignment", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  expect(liveText(store).align).toBe("center");

  await userEvent.click(screen.getByRole("button", { name: "Align text right" }));

  await vi.waitFor(() => {
    expect(liveText(store).align).toBe("right");
  });
  await expect
    .element(screen.getByRole("button", { name: "Align text right" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Align text center" }))
    .toHaveAttribute("aria-pressed", "false");
  screen.unmount();
});

it("changes the font size from the slider", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  const thumb = screen.getByRole("slider", { name: "Font size" });
  await expect.element(thumb).toBeVisible();

  const start = liveText(store).size;
  const expected = fontSizeFromSliderPosition(sliderPositionFromFontSize(start) + 10);
  expect(expected).toBeGreaterThan(start);

  (await thumb.element()).focus();
  await userEvent.keyboard("{ArrowRight}");

  await vi.waitFor(() => {
    expect(liveText(store).size).toBe(expected);
  });
  screen.unmount();
});

it("changes the font size from the number beside it", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Font size in pixels")).toBeVisible();

  type_(input("Font size in pixels"), "120");

  await vi.waitFor(() => {
    expect(liveText(store).size).toBe(120);
  });
  // The slider follows the number, so the two never disagree (app.js:2361).
  await expect
    .element(screen.getByRole("slider", { name: "Font size" }))
    .toHaveAttribute("aria-valuenow", String(sliderPositionFromFontSize(120)));
  screen.unmount();
});

/*
 * ensureTextFits (app.js:2947). Task 15's layer refits only when the words
 * change, so growing the font from the inspector has to grow the box here or
 * the extra lines are clipped.
 */
it("grows the box when the font outgrows it", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) text.text = "A caption long enough to wrap more than once";
  });
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  const before = liveText(store).height;
  await expect.element(screen.getByLabelText("Font size in pixels")).toBeVisible();

  type_(input("Font size in pixels"), "120");

  await vi.waitFor(() => {
    expect(liveText(store).height).toBeGreaterThan(before);
  });
  screen.unmount();
});

/*
 * app.js:2943 caps the grown box at the whole canvas
 * (Math.min(1, neededPixels / state.stageHeight)). Without the cap a text can be
 * given a height greater than the slide it sits on, which no stage can draw.
 * The text below overflows 180px type well past one canvas height, so the cap is
 * doing work rather than being satisfied by accident.
 */
it("never grows a box past the whole canvas", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) {
      text.text =
        "A caption long enough that it has to wrap many times over at the largest size the slider offers, and then some more besides";
      text.height = 0.1;
    }
  });
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Font size in pixels")).toBeVisible();

  type_(input("Font size in pixels"), "180");

  await vi.waitFor(() => {
    expect(liveText(store).size).toBe(180);
    // It grew, so the refit ran and the cap is what stopped it.
    expect(liveText(store).height).toBeGreaterThan(0.1);
  });
  expect(liveText(store).height).toBe(1);
  screen.unmount();
});

/* The same control must leave a box that already fits alone (app.js:2941). */
it("leaves a box that already fits alone", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.mutate((document) => {
    const text = document.slides[0]?.texts[0];
    if (text !== undefined) {
      text.text = "Hi";
      text.height = 0.5;
    }
  });
  store.selectOnly("text", "text-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Font size in pixels")).toBeVisible();

  type_(input("Font size in pixels"), "24");

  await vi.waitFor(() => {
    expect(liveText(store).size).toBe(24);
  });
  expect(liveText(store).height).toBe(0.5);
  screen.unmount();
});

/*
 * app.js:1953 renders an empty body under a count for a multi-selection. No
 * control there has ever applied a style to more than one layer, which is what
 * the brief's "applies to every selected text layer at once" asked for.
 */
it("offers only the count and a delete for a multi-selection", async () => {
  const store = storeFor(fixtureProject({ texts: 2 }));
  store.select(["text:text-1-1", "text:text-1-2"]);
  const screen = await mount(store);

  await expect
    .element(screen.getByRole("heading", { name: "2 layers selected" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Delete selected layers" }))
    .toBeVisible();
  expect(document.querySelector('[aria-label="Font size"]')).toBeNull();
  expect(document.querySelector('[aria-label="Text alignment"]')).toBeNull();
  screen.unmount();
});

it("deletes the selection from the header", async () => {
  const store = storeFor(fixtureProject({ texts: 2 }));
  store.select(["text:text-1-1", "text:text-1-2"]);
  const screen = await mount(store);

  await userEvent.click(screen.getByRole("button", { name: "Delete selected layers" }));

  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.texts).toHaveLength(0);
  });
  screen.unmount();
});

it("offers Done while an overlay is being cropped", async () => {
  const store = storeFor(fixtureProject({ texts: 1, overlays: 1 }));
  store.selectOnly("overlay", "overlay-1-1");
  store.setCropping("overlay-1-1");
  const finished = vi.fn();
  const screen = await render(
    <Inspector store={store} library={LIBRARY} onFinishCrop={finished} />,
  );

  await expect.element(screen.getByRole("heading", { name: "Crop" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));

  expect(finished).toHaveBeenCalledTimes(1);
  screen.unmount();
});

it("rotates an overlay from the number beside the slider", async () => {
  const store = storeFor(fixtureProject({ texts: 1, overlays: 1 }));
  store.selectOnly("overlay", "overlay-1-1");
  const screen = await mount(store);
  await expect.element(screen.getByLabelText("Rotation in degrees, typed")).toBeVisible();

  type_(input("Rotation in degrees, typed"), "400");

  // app.js:2486 folds any angle back into one turn.
  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.overlays[0]?.rotation).toBe(40);
  });
  screen.unmount();
});

it("zooms and resets the photo", async () => {
  const store = storeFor(fixtureProject({ texts: 1 }));
  const screen = await mount(store, { photoAdjust: true });
  store.mutate((document) => {
    const slide = document.slides[0];
    if (slide !== undefined) {
      slide.imageScale = 2;
      slide.imageX = 0.2;
    }
  });
  await expect.element(screen.getByText("200%")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Reset photo" }));

  await vi.waitFor(() => {
    expect(store.getSnapshot().project.slides[0]?.imageScale).toBe(1);
    expect(store.getSnapshot().project.slides[0]?.imageX).toBe(0);
  });
  screen.unmount();
});

/*
 * app.js:3305-3320. Below 780px a 294px column and a usable stage do not both
 * fit, so the panel becomes a sheet the header raises.
 *
 * Visibility is read rather than the class, so the assertion fails if the
 * breakpoint moves or the rule is renamed.
 */
it("hides the panel behind a toggle on a narrow screen", async () => {
  await page.viewport(1280, 900);
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await render(
    <Inspector store={store} library={LIBRARY} mobileOpen={false} />,
  );
  await expect
    .element(screen.getByRole("heading", { name: "Text settings" }))
    .toBeVisible();

  await page.viewport(414, 896);

  await vi.waitFor(() => {
    const panel = document.querySelector("[data-inspector]");
    if (panel === null) throw new Error("The panel is gone entirely.");
    expect(getComputedStyle(panel).display).toBe("none");
  });
  screen.unmount();
});

it("shows the panel on a narrow screen once it is raised", async () => {
  await page.viewport(414, 896);
  const store = storeFor(fixtureProject({ texts: 1 }));
  store.selectOnly("text", "text-1-1");
  const screen = await render(
    <Inspector store={store} library={LIBRARY} mobileOpen={true} />,
  );

  await vi.waitFor(() => {
    const panel = document.querySelector("[data-inspector]");
    if (panel === null) throw new Error("The panel is gone entirely.");
    expect(getComputedStyle(panel).display).toBe("block");
    expect(getComputedStyle(panel).position).toBe("fixed");
  });
  await expect
    .element(screen.getByRole("heading", { name: "Text settings" }))
    .toBeVisible();
  screen.unmount();
});

/*
 * The sheet where it is actually raised. app.js raised it from four places
 * (app.js:2201, app.js:2975, app.js:3399, app.js:4722); three of those are one
 * event, a layer arriving on the slide, and Editor.tsx derives it from the
 * layer count rather than reaching into the task that owns those call sites.
 */
it("raises the sheet from the header and when a layer arrives", async () => {
  // Under the 780px breakpoint, and wide enough that the stage is still a
  // target a double click can land on.
  await page.viewport(700, 900);
  const project = fixtureProject({ slides: 2, texts: 1 });
  /*
   * Slide 2 must out-count slide 1 *after* the double click below adds a layer
   * to slide 1, or the counts tie and the move reads as no growth either way.
   * Slide 1 ends on two; slide 2 starts on four.
   */
  for (const index of [2, 3, 4]) {
    project.slides[1]?.texts.push({
      ...project.slides[1].texts[0]!,
      id: `text-2-${String(index)}`,
      y: 0.1 * index,
      z: index,
    });
  }
  const client = {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent: Project) =>
      Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 }),
    setStatus: () => Promise.resolve({}),
  };
  const screen = await render(
    <MemoryRouter initialEntries={["/projects/project-1"]}>
      <ToastProvider>
        <Routes>
          <Route
            path="/projects/:id"
            element={
              <Editor
                projectId="project-1"
                client={client}
                library={
                  new LibraryCache({
                    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
                  })
                }
                subscribe={() => () => undefined}
              />
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
  const toggle = screen.getByRole("button", { name: "Toggle text controls" });
  await expect.element(toggle).toBeVisible();
  const panel = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>("[data-inspector]");
    if (found === null) throw new Error("The panel is gone entirely.");
    return found;
  };
  await vi.waitFor(() => {
    expect(getComputedStyle(panel()).display).toBe("none");
  });

  await userEvent.click(toggle);
  await vi.waitFor(() => {
    expect(getComputedStyle(panel()).display).toBe("block");
  });

  await userEvent.click(toggle);
  await vi.waitFor(() => {
    expect(getComputedStyle(panel()).display).toBe("none");
  });

  /*
   * A double click on bare canvas adds a text (app.js:2296-2311), which is one
   * of the three "a layer arrived" moments the sheet answers.
   *
   * Dispatched rather than driven, because the layer stack covers the stage
   * with pointer-events: none and the harness refuses to click through it. The
   * listener this reaches is a plain document listener reading clientX and
   * clientY, so it sees exactly what a real double click gives it.
   */
  const stack = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
  if (stack === null) throw new Error("The editor has no layer stack.");
  const box = stack.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  stack.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      button: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );

  await vi.waitFor(() => {
    expect(getComputedStyle(panel()).display).toBe("block");
  });

  /*
   * Paging the rail onto a busier slide is not one of app.js's four call sites,
   * so it must not raise the sheet. The count is kept beside the slide it was
   * counted on for exactly this: slide 1 has ended on two layers and slide 2
   * starts on four, so a bare count comparison would read the move as growth.
   */
  await userEvent.click(toggle);
  await vi.waitFor(() => {
    expect(getComputedStyle(panel()).display).toBe("none");
  });

  await userEvent.click(screen.getByRole("button", { name: "Open slide 2" }));

  await vi.waitFor(() => {
    // A positive signal that the slide really changed, ahead of the absence.
    expect(document.querySelectorAll('[data-layer-kind="text"]')).toHaveLength(4);
  });
  expect(getComputedStyle(panel()).display).toBe("none");
  screen.unmount();
});

/*
 * The contract behind the panel's data-inspector attribute, driven through the
 * real panel for the first time.
 *
 * LayerStack.tsx:113 asks `target.closest("[data-inspector], .inspector")` on a
 * capturing pointerdown, so that pressing a control in the panel commits an
 * open inline edit and *keeps the layer selected* (app.js:4830). The
 * `.inspector` half of that selector can never match: the panel's class comes
 * from a CSS module and is hashed, so the attribute is the only working hook.
 *
 * The only other test of this behaviour builds its own
 * `<div data-inspector="true">`, which would keep passing if either side were
 * renamed. This one mounts the editor and presses a real swatch, so a rename on
 * either side breaks it.
 */
it("keeps the layer selected when a control in the real panel is pressed", async () => {
  await page.viewport(1280, 900);
  const project = fixtureProject({ texts: 1 });
  const client = {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent: Project) =>
      Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 }),
    setStatus: () => Promise.resolve({}),
  };
  const screen = await render(
    <MemoryRouter initialEntries={["/projects/project-1"]}>
      <ToastProvider>
        <Routes>
          <Route
            path="/projects/:id"
            element={
              <Editor
                projectId="project-1"
                client={client}
                library={
                  new LibraryCache({
                    listLibrary: () => Promise.resolve({ items: [], total: 0 }),
                  })
                }
                subscribe={() => () => undefined}
              />
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );

  // Select the layer, then open the inline editor on it, which is the state
  // the capturing listener above only arms for.
  const layer = document.querySelector<HTMLElement>('[data-layer-kind="text"]');
  if (layer === null) throw new Error("The slide has no text layer.");
  await userEvent.click(layer);
  await expect.element(screen.getByPlaceholder("Type something…")).toBeVisible();
  await userEvent.dblClick(layer);
  await vi.waitFor(() => {
    expect(document.querySelector("[data-text-editor]")).not.toBeNull();
  });

  await userEvent.click(screen.getByRole("button", { name: "Use Pink text" }));

  // The edit is committed and the layer is still selected, so the panel still
  // describes it rather than emptying under the press that was meant to style it.
  await vi.waitFor(() => {
    expect(document.querySelector("[data-text-editor]")).toBeNull();
  });
  await expect
    .element(screen.getByRole("heading", { name: "Text settings" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Use Pink text" }))
    .toHaveAttribute("aria-pressed", "true");
  screen.unmount();
});
