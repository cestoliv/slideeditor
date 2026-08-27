import { expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../design/tokens.css";
import "../../design/reset.css";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../app/accounts.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { AssetRail } from "./AssetRail.js";
import { Editor } from "./Editor.js";
import { EditorStore } from "./store.js";
import type { EditorClient } from "./Editor.js";
import { fixtureProject } from "./testing.js";
import { libraryItem } from "./layers/testing.js";
import { ASSET_DRAG_TYPE } from "./layers/useAssetDrop.js";

/*
 * The asset rail, reached through the running editor rather than mounted on its
 * own. Choosing a curated asset is the one route onto a slide that a person had
 * no way to take: the rail did not exist, so only a desktop file drop or a
 * paste worked, and picking from the library was an agent-only capability.
 */

function assetItem(
  id: string,
  name: string,
  description = "",
  accountId = DEFAULT_ACCOUNT_ID,
): LibraryItem {
  return { ...libraryItem(id, 400, 400, name), kind: "asset", description, accountId };
}

type Harness = {
  project: Project;
  client: EditorClient;
  cache: LibraryCache;
  saved: Project[];
};

function harness(options: { assets?: LibraryItem[]; overlays?: number } = {}): Harness {
  const project = fixtureProject({ texts: 0, overlays: options.overlays ?? 0 });
  const saved: Project[] = [];
  const items: LibraryItem[] = [
    ...project.slides.map((slide) => libraryItem(slide.backgroundItemId)),
    ...project.slides.flatMap((slide) =>
      slide.overlays.map((overlay) => assetItem(overlay.itemId, "On this slideshow")),
    ),
    ...(options.assets ?? []),
  ];
  return {
    project,
    saved,
    cache: new LibraryCache({
      listLibrary: () => Promise.resolve({ items, total: items.length }),
    }),
    client: {
      getProject: () => Promise.resolve({ project: structuredClone(project) }),
      save: (sent) => {
        saved.push(structuredClone(sent));
        return Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 });
      },
      setStatus: () => Promise.resolve({}),
    },
  };
}

function emptyAccountsStore(): AccountsStore {
  return new AccountsStore({
    listAccounts: () => Promise.resolve({ accounts: [] }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
}

async function openEditor(built: Harness) {
  await render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/p/project-1"]}>
        <AccountsProvider store={emptyAccountsStore()}>
          <Editor
            projectId={built.project.id}
            client={built.client}
            library={built.cache}
            subscribe={() => () => undefined}
          />
        </AccountsProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
  await expect.element(page.getByLabelText("Assets")).toBeInTheDocument();
}

function tileFor(id: string): HTMLElement {
  const tile = document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
  if (tile === null) throw new Error(`No tile for ${id}.`);
  return tile;
}

function dragEvent(type: string, transfer: DataTransfer, at: DOMRect): DragEvent {
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
    clientX: at.left + at.width / 2,
    clientY: at.top + at.height / 2,
  });
}

it("offers the library's assets to drag onto the slide", async () => {
  const built = harness({
    assets: [assetItem("sticker-1", "Cyan sticker"), assetItem("sticker-2", "Red badge")],
  });
  await openEditor(built);

  // A fresh slideshow uses no assets, so the rail starts empty and says so.
  await expect
    .element(page.getByText(/No assets on this slideshow yet/))
    .toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Library" }));

  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();
  await expect.element(page.getByAltText("Red badge")).toBeInTheDocument();
});

it("puts a library asset on the slide when it is dragged onto the canvas", async () => {
  const built = harness({ assets: [assetItem("sticker-1", "Cyan sticker")] });
  await openEditor(built);
  await userEvent.click(page.getByRole("button", { name: "Library" }));
  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();

  // The whole journey, in the three events a real drag produces: the tile
  // writes the payload, and the canvas reads it back.
  const transfer = new DataTransfer();
  const tile = tileFor("sticker-1");
  tile.dispatchEvent(dragEvent("dragstart", transfer, tile.getBoundingClientRect()));
  expect(transfer.getData(ASSET_DRAG_TYPE)).toBe("sticker-1");

  const stage = document.querySelector<HTMLElement>('[data-testid="stage"]');
  if (stage === null) throw new Error("No stage.");
  const box = stage.getBoundingClientRect();
  document.dispatchEvent(dragEvent("dragover", transfer, box));
  document.dispatchEvent(dragEvent("drop", transfer, box));

  await expect.element(page.getByLabelText("Photo overlay: Cyan sticker")).toBeVisible();
});

it("shows only the assets this slideshow uses until the scope is switched", async () => {
  const built = harness({
    overlays: 1,
    assets: [assetItem("sticker-1", "Cyan sticker")],
  });
  await openEditor(built);

  // "In use" is the opening scope, and it lists the slideshow's own asset only.
  await expect.element(page.getByAltText("On this slideshow")).toBeInTheDocument();
  expect(page.getByAltText("Cyan sticker").query()).toBe(null);

  await userEvent.click(page.getByRole("button", { name: "Library" }));

  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();
});

it("does not offer another account's assets in the Library tab", async () => {
  const built = harness({
    assets: [
      assetItem("sticker-1", "Cyan sticker"),
      assetItem("sticker-2", "Their sticker", "", "other-account"),
    ],
  });
  await openEditor(built);
  await userEvent.click(page.getByRole("button", { name: "Library" }));

  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();
  expect(page.getByAltText("Their sticker").query()).toBe(null);
});

it("filters the assets as the search is typed", async () => {
  const built = harness({
    assets: [
      assetItem("sticker-1", "Cyan sticker"),
      assetItem("sticker-2", "Red badge", "a round mark"),
    ],
  });
  await openEditor(built);
  await userEvent.click(page.getByRole("button", { name: "Library" }));
  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();

  await userEvent.fill(page.getByLabelText("Search the asset library"), "badge");

  await expect.element(page.getByAltText("Red badge")).toBeInTheDocument();
  await expect.poll(() => page.getByAltText("Cyan sticker").query()).toBe(null);

  // The description is part of the haystack, the way app.js:1651 searched it.
  await userEvent.fill(page.getByLabelText("Search the asset library"), "round mark");
  await expect.element(page.getByAltText("Red badge")).toBeInTheDocument();
});

it("previews an asset under the pointer, and not while it is dragged", async () => {
  const built = harness({ assets: [assetItem("sticker-1", "Cyan sticker")] });
  await openEditor(built);
  await userEvent.click(page.getByRole("button", { name: "Library" }));
  await expect.element(page.getByAltText("Cyan sticker")).toBeInTheDocument();
  const tile = tileFor("sticker-1");

  await userEvent.hover(tile);

  // Portalled to the body, because the rail's backdrop-filter would otherwise
  // trap a fixed element inside a 168px column.
  const shown = await page.getByTestId("asset-preview").element();
  expect(shown.parentElement).toBe(document.body);
  expect(shown.getAttribute("src")).toBe(tileFor("sticker-1").querySelector("img")?.src);

  const transfer = new DataTransfer();
  tile.dispatchEvent(dragEvent("dragstart", transfer, tile.getBoundingClientRect()));

  // app.js:3156. A drag carries its own image, so a preview beside it is noise.
  await expect.poll(() => page.getByTestId("asset-preview").query()).toBe(null);
});

it("takes an asset off the slideshow when it is dropped on the trash", async () => {
  const built = harness({ overlays: 1 });
  const itemId = built.project.slides[0]?.overlays[0]?.itemId;
  if (itemId === undefined) throw new Error("The fixture has no overlay.");
  await openEditor(built);
  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeVisible();

  const tile = tileFor(itemId);
  const transfer = new DataTransfer();
  tile.dispatchEvent(dragEvent("dragstart", transfer, tile.getBoundingClientRect()));
  const trash = await page.getByTestId("asset-trash").element();
  const box = trash.getBoundingClientRect();
  trash.dispatchEvent(dragEvent("dragover", transfer, box));
  await expect.poll(() => trash.getAttribute("data-hot")).toBe("true");
  trash.dispatchEvent(dragEvent("drop", transfer, box));

  // Off every slide, and the overlay that drew it goes with it.
  await expect.poll(() => page.getByLabelText(/^Photo overlay/).query()).toBe(null);
});

it("uploads a chosen file and shows it in the library", async () => {
  const uploaded = assetItem("uploaded-1", "Uploaded mark");
  const upload = vi.fn(() => Promise.resolve(uploaded));
  const built = harness();
  const store = new EditorStore(built.project, {
    save: (sent) => Promise.resolve(sent),
  });
  await built.cache.load();
  /*
   * The rail on its own for this one, because the injection point is the rail's
   * own prop rather than the editor's wiring. Everything driven below is what a
   * person touches: the button, the picker it opens, and the grid after.
   */
  await render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/p/project-1"]}>
        <AssetRail
          store={store}
          library={built.cache.getSnapshot().items}
          cache={built.cache}
          upload={upload}
        />
      </MemoryRouter>
    </ToastProvider>,
  );

  const picker = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  if (picker === null) throw new Error("No asset picker.");
  await userEvent.upload(picker, new File(["x"], "mark.png", { type: "image/png" }));

  expect(upload).toHaveBeenCalledTimes(1);
  // Remembered in the cache, so it is on screen without a round trip, and the
  // rail has switched to the scope that can show a brand new asset.
  await expect.poll(() => built.cache.get("uploaded-1")).not.toBe(null);
});
