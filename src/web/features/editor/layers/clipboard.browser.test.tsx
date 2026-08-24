import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import type { EditorStore } from "../store.js";
import {
  CLIPBOARD_LAYER_TYPE,
  CLIPBOARD_STORAGE_KEY,
  CLIPBOARD_TEXT_PREFIX,
  LayerClipboard,
} from "./clipboard.js";
import {
  LayerHarness,
  editorStore,
  libraryFor,
  libraryItem,
  measuredStage,
} from "./testing.js";

/*
 * Copy and paste, through the document listeners the editor binds.
 *
 * The three payloads a copy writes are the interesting part: a browser strips
 * the custom MIME type when the clipboard crosses a tab, so the token in
 * text/plain and the mirror in localStorage are what make copy-here /
 * paste-there work at all.
 */

afterEach(() => {
  window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
});

function clipboardEvent(type: "copy" | "paste", data: DataTransfer): ClipboardEvent {
  return new ClipboardEvent(type, {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
}

function projectWithLayers(): Project {
  const project = fixtureProject({ slides: 2, texts: 1, overlays: 1 });
  return project;
}

async function open(
  options: {
    project?: Project;
    upload?: (file: File, name: string) => Promise<LibraryItem>;
  } = {},
) {
  const project = options.project ?? projectWithLayers();
  const store = editorStore(project);
  const clipboard = new LayerClipboard(window.localStorage);
  const toasts: string[] = [];
  await render(
    <LayerHarness
      store={store}
      library={libraryFor(project)}
      clipboard={clipboard}
      upload={options.upload}
      toast={(message) => toasts.push(message)}
    />,
  );
  await measuredStage();
  return { store, clipboard, toasts, project };
}

function slideOf(store: EditorStore, index: number) {
  const slide = store.getSnapshot().project.slides[index];
  if (slide === undefined) throw new Error("No such slide.");
  return slide;
}

it("copies a layer and pastes it into another slide", async () => {
  const { store } = await open();
  const overlay = slideOf(store, 0).overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  store.selectOnly("overlay", overlay.id);

  const data = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", data));
  expect(data.getData(CLIPBOARD_LAYER_TYPE)).not.toBe("");

  store.setActiveSlide(slideOf(store, 1).id);
  document.dispatchEvent(clipboardEvent("paste", data));

  const pasted = slideOf(store, 1).overlays;
  expect(pasted).toHaveLength(2);
  const added = pasted[1];
  if (added === undefined) throw new Error("Nothing was pasted.");
  expect(added.id).not.toBe(overlay.id);
  expect(added.itemId).toBe(overlay.itemId);
  expect(store.getSnapshot().selection).toEqual([`overlay:${added.id}`]);
});

it("writes a token in plain text alongside the layer", async () => {
  const { store } = await open();
  const text = slideOf(store, 0).texts[0];
  if (text === undefined) throw new Error("The fixture has no text.");
  store.selectOnly("text", text.id);

  const data = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", data));

  const sentinel = data.getData("text/plain");
  expect(sentinel.startsWith(CLIPBOARD_TEXT_PREFIX)).toBe(true);
  const payload: unknown = JSON.parse(data.getData(CLIPBOARD_LAYER_TYPE));
  expect((payload as { token: string }).token).toBe(
    sentinel.slice(CLIPBOARD_TEXT_PREFIX.length),
  );
  // The mirror another tab reads carries the same token, which is the only
  // thing that lets it tell a fresh copy from a stale one.
  const mirrored: unknown = JSON.parse(
    window.localStorage.getItem(CLIPBOARD_STORAGE_KEY) ?? "null",
  );
  expect((mirrored as { token: string }).token).toBe(
    (payload as { token: string }).token,
  );
});

it("pastes a layer copied in another tab", async () => {
  const first = await open();
  const overlay = slideOf(first.store, 0).overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  first.store.selectOnly("overlay", overlay.id);
  const copyData = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", copyData));
  const token = copyData.getData("text/plain").slice(CLIPBOARD_TEXT_PREFIX.length);

  // A second editor, with nothing in memory, is what another tab looks like.
  document.body.replaceChildren();
  const second = await open();
  const stripped = new DataTransfer();
  // Chrome hands the other tab the sentinel only: the custom type does not
  // survive the crossing.
  stripped.setData("text/plain", `${CLIPBOARD_TEXT_PREFIX}${token}`);
  document.dispatchEvent(clipboardEvent("paste", stripped));

  expect(slideOf(second.store, 0).overlays).toHaveLength(2);
});

it("refuses a sentinel whose token the mirror does not match", async () => {
  const { store } = await open();
  const overlay = slideOf(store, 0).overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  store.selectOnly("overlay", overlay.id);

  // Copy first, so both the in-memory slot and the localStorage mirror hold a
  // real payload under a real token. Without that there is nothing for the
  // token check to refuse, and the paste below would be turned away merely for
  // finding an empty mirror.
  const copied = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", copied));
  const token = copied.getData("text/plain").slice(CLIPBOARD_TEXT_PREFIX.length);
  expect(token).not.toBe("");
  expect(window.localStorage.getItem(CLIPBOARD_STORAGE_KEY)).not.toBe(null);

  // A sentinel from some other copy, in some other tab. The mirror holds
  // something, but not this.
  const stale = new DataTransfer();
  stale.setData("text/plain", `${CLIPBOARD_TEXT_PREFIX}${token}-stale`);
  document.dispatchEvent(clipboardEvent("paste", stale));

  // Nothing is inserted. Resolving the mirror regardless of its token would
  // paste the layer that was copied a moment ago instead.
  expect(slideOf(store, 0).overlays).toHaveLength(1);
});

it("refuses a sentinel when nothing has been copied at all", async () => {
  const { store } = await open();

  const data = new DataTransfer();
  data.setData("text/plain", `${CLIPBOARD_TEXT_PREFIX}not-a-real-token`);
  document.dispatchEvent(clipboardEvent("paste", data));

  expect(slideOf(store, 0).overlays).toHaveLength(1);
});

it("offsets a paste onto the same slide so it is visible", async () => {
  const { store } = await open();
  const overlay = slideOf(store, 0).overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  const origin = { x: overlay.x, y: overlay.y };
  store.selectOnly("overlay", overlay.id);

  const data = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", data));
  document.dispatchEvent(clipboardEvent("paste", data));
  const firstPaste = slideOf(store, 0).overlays[1];
  if (firstPaste === undefined) throw new Error("Nothing was pasted.");
  expect(firstPaste.x).toBeCloseTo(origin.x + 0.03, 6);

  document.dispatchEvent(clipboardEvent("paste", data));
  const secondPaste = slideOf(store, 0).overlays[2];
  if (secondPaste === undefined) throw new Error("Nothing was pasted twice.");
  // app.js:4740 rewrites the payload to what was just pasted, so a run of
  // pastes walks down the slide instead of stacking on one spot.
  expect(secondPaste.x).toBeCloseTo(origin.x + 0.06, 6);
});

it("puts a pasted layer on top of the stack", async () => {
  const { store } = await open();
  const overlay = slideOf(store, 0).overlays[0];
  const text = slideOf(store, 0).texts[0];
  if (overlay === undefined || text === undefined) throw new Error("Thin fixture.");
  store.selectOnly("overlay", overlay.id);

  const data = new DataTransfer();
  document.dispatchEvent(clipboardEvent("copy", data));
  document.dispatchEvent(clipboardEvent("paste", data));

  const pasted = slideOf(store, 0).overlays[1];
  expect(pasted?.z).toBeGreaterThan(text.z ?? 0);
});

it("pastes an image from the system clipboard as a new asset", async () => {
  const item = libraryItem("pasted-1", 512, 512, "Pasted image");
  const upload = vi.fn(() => Promise.resolve(item));
  const project = fixtureProject({ slides: 1, texts: 0, overlays: 0 });
  const { store } = await open({ project, upload });

  const data = new DataTransfer();
  data.items.add(new File(["binary"], "shot.png", { type: "image/png" }));
  document.dispatchEvent(clipboardEvent("paste", data));

  await expect.poll(() => slideOf(store, 0).overlays.length).toBe(1);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(slideOf(store, 0).overlays[0]?.itemId).toBe("pasted-1");
});

it("copies nothing while a field has the focus", async () => {
  const { store } = await open();
  const overlay = slideOf(store, 0).overlays[0];
  if (overlay === undefined) throw new Error("The fixture has no overlay.");
  store.selectOnly("overlay", overlay.id);
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();

  const data = new DataTransfer();
  field.dispatchEvent(clipboardEvent("copy", data));

  // app.js:4593. A field owns its own clipboard, so the layers stay out of it.
  expect(data.getData(CLIPBOARD_LAYER_TYPE)).toBe("");
  field.remove();
});
