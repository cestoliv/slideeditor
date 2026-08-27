import { expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { useState } from "react";
import "../../design/tokens.css";
import "../../design/reset.css";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem } from "@shared/schema/index.js";
import { LibraryCache } from "../../app/useLibrary.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import { libraryItem } from "./layers/testing.js";

/*
 * The picker both entry points use. Everything below is driven the way a person
 * drives it: press the button that opens it, read the grid, type in the search,
 * press a tile.
 */

function background(
  id: string,
  name: string,
  description = "",
  accountId = DEFAULT_ACCOUNT_ID,
): LibraryItem {
  return {
    ...libraryItem(id, 1080, 1920, name),
    kind: "background",
    description,
    accountId,
  };
}

function asset(id: string, name: string): LibraryItem {
  return { ...libraryItem(id, 400, 400, name), kind: "asset" };
}

function cacheOf(items: LibraryItem[]): LibraryCache {
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items, total: items.length }),
  });
}

type Choose = (items: readonly LibraryItem[]) => void;

type HostProps = {
  cache: LibraryCache;
  onChoose: Choose;
  upload?: (file: File) => Promise<LibraryItem>;
  multiple?: boolean;
  accountId?: string;
};

type Opened = {
  cache: LibraryCache;
  onChoose: Mock<Choose>;
};

/** The caller's half: a button that opens the picker, and it owns the flag. */
function Host({
  cache,
  onChoose,
  upload,
  multiple = false,
  accountId = DEFAULT_ACCOUNT_ID,
}: HostProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Change background
      </button>
      <BackgroundPicker
        open={open}
        onOpenChange={setOpen}
        title="Change background"
        description="Choose one from your library, or upload a new image."
        onChoose={onChoose}
        multiple={multiple}
        cache={cache}
        upload={upload}
        accountId={accountId}
      />
    </>
  );
}

/**
 * Renders the caller and opens the picker. The library is loaded first, so the
 * grid is settled rather than mid-request when the assertions start.
 */
async function openPicker(
  items: LibraryItem[],
  options: {
    upload?: (file: File) => Promise<LibraryItem>;
    multiple?: boolean;
    accountId?: string;
  } = {},
): Promise<Opened> {
  const cache = cacheOf(items);
  await cache.load();
  const onChoose = vi.fn<Choose>();
  await render(
    <Host
      cache={cache}
      onChoose={onChoose}
      multiple={options.multiple ?? false}
      accountId={options.accountId ?? DEFAULT_ACCOUNT_ID}
      {...(options.upload === undefined ? {} : { upload: options.upload })}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Change background" }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  return { cache, onChoose };
}

function png(name: string): File {
  return new File(["png"], name, { type: "image/png" });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("No file picker.");
  return input;
}

it("lists the library's backgrounds and none of its assets", async () => {
  await openPicker([
    background("bg-1", "Blue sky"),
    background("bg-2", "Night street"),
    asset("asset-1", "Cyan sticker"),
  ]);

  // Both backgrounds first. The grid that would have to carry the asset has
  // rendered by the time these pass, so the absence below is a real absence.
  await expect.element(page.getByRole("button", { name: "Blue sky" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Night street" })).toBeVisible();
  expect(page.getByRole("button", { name: "Cyan sticker" }).query()).toBe(null);
});

it("narrows the list as the search is typed", async () => {
  await openPicker([
    background("bg-1", "Blue sky"),
    background("bg-2", "Night street", "a wet pavement"),
  ]);
  await expect.element(page.getByRole("button", { name: "Blue sky" })).toBeVisible();

  await userEvent.fill(page.getByLabelText("Search backgrounds"), "night");

  await expect.element(page.getByRole("button", { name: "Night street" })).toBeVisible();
  await expect
    .poll(() => page.getByRole("button", { name: "Blue sky" }).query())
    .toBe(null);

  // The description is part of the haystack, the way app.js:1311 searched it.
  await userEvent.fill(page.getByLabelText("Search backgrounds"), "wet pavement");
  await expect.element(page.getByRole("button", { name: "Night street" })).toBeVisible();
});

it("hands the caller the background that was pressed, and closes", async () => {
  const wanted = background("bg-2", "Night street");
  const { onChoose } = await openPicker([background("bg-1", "Blue sky"), wanted]);

  await userEvent.click(page.getByRole("button", { name: "Night street" }));

  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledWith([wanted]);
  await expect.poll(() => page.getByRole("dialog").query()).toBe(null);
});

it("uploads a chosen file, remembers it, and hands that back", async () => {
  const uploaded = background("uploaded-1", "Fresh photo");
  const upload = vi.fn(() => Promise.resolve(uploaded));
  const { cache, onChoose } = await openPicker([background("bg-1", "Blue sky")], {
    upload,
  });

  await userEvent.upload(
    fileInput(),
    new File(["x"], "fresh-photo.png", { type: "image/png" }),
  );

  expect(upload).toHaveBeenCalledTimes(1);
  // In the cache, or the stage resolves the new id to nothing and the slide
  // paints an empty frame.
  await expect.poll(() => cache.get("uploaded-1")).not.toBe(null);
  await expect.poll(() => onChoose.mock.calls).toEqual([[[uploaded]]]);
});

it("says so when an upload fails, and stays open", async () => {
  const upload = vi.fn(() => Promise.reject(new Error("no")));
  const { onChoose } = await openPicker([background("bg-1", "Blue sky")], { upload });

  await userEvent.upload(
    fileInput(),
    new File(["x"], "broken.png", { type: "image/png" }),
  );

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That image couldn’t be uploaded.");
  // The alert is downstream of the same failed upload, so by the time it is on
  // screen a wrongly chosen item would already have been handed over.
  expect(onChoose).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).toBeVisible();
});

it("hands the caller nothing when it is cancelled", async () => {
  const { onChoose } = await openPicker([background("bg-1", "Blue sky")]);
  await expect.element(page.getByRole("button", { name: "Blue sky" })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Cancel" }));

  // The dialog leaving is the close path's own signal. A picker that chose
  // something on the way out would have called onChoose before this passes.
  await expect.poll(() => page.getByRole("dialog").query()).toBe(null);
  expect(onChoose).not.toHaveBeenCalled();
});

it("tells a person with an empty library what to do about it", async () => {
  await openPicker([asset("asset-1", "Cyan sticker")]);

  // An empty box is the first thing a new person would otherwise meet.
  await expect
    .element(page.getByText(/No backgrounds in your library yet/))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Upload an image" }))
    .toBeVisible();
});

it("separates a library with nothing in it from a search that matched nothing", async () => {
  await openPicker([background("bg-1", "Blue sky")]);

  await userEvent.fill(page.getByLabelText("Search backgrounds"), "mountain");

  await expect.element(page.getByText("Nothing matches that search.")).toBeVisible();
});

it("uploads every chosen file when the caller takes more than one", async () => {
  const upload = vi.fn((file: File) =>
    Promise.resolve(background(`item-${file.name}`, file.name)),
  );
  const { onChoose } = await openPicker([], { upload, multiple: true });

  await expect.element(fileInput()).toHaveAttribute("multiple");
  await userEvent.upload(fileInput(), [png("beach.png"), png("dunes.png")]);

  // One slide per image is what the New slide button has always given, so the
  // batch has to arrive whole rather than one at a time.
  await expect
    .poll(() => onChoose.mock.calls.map((call) => call[0].map((item) => item.name)))
    .toEqual([["beach.png", "dunes.png"]]);
});

it("keeps the uploads that worked when one of them fails", async () => {
  const upload = vi.fn((file: File) =>
    file.name === "bad.png"
      ? Promise.reject(new Error("no room"))
      : Promise.resolve(background(`item-${file.name}`, file.name)),
  );
  const { onChoose } = await openPicker([], { upload, multiple: true });

  await userEvent.upload(fileInput(), [png("good.png"), png("bad.png"), png("fine.png")]);

  // app.js:4167. One bad file does not take the rest of the batch with it.
  await expect
    .poll(() => onChoose.mock.calls.map((call) => call[0].map((item) => item.name)))
    .toEqual([["good.png", "fine.png"]]);
});

it("takes an image the browser could not name a type for", async () => {
  const upload = vi.fn(() => Promise.resolve(background("item-1", "Beach")));
  const { onChoose } = await openPicker([], { upload });

  // A picker can hand back a file with no type at all, so the extension is the
  // second chance rather than the only check.
  await userEvent.upload(fileInput(), new File(["png"], "beach.PNG", { type: "" }));

  await expect.poll(() => onChoose.mock.calls).toHaveLength(1);
});

it("asks for an image when the chosen file is not one", async () => {
  const upload = vi.fn(() => Promise.resolve(background("item-1", "Beach")));
  const { onChoose } = await openPicker([], { upload });

  await userEvent.upload(
    fileInput(),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Choose an image file.");
  // The alert is the same handler's own output, so a file that had wrongly been
  // uploaded would already have reached the uploader by the time it is up.
  expect(upload).not.toHaveBeenCalled();
  expect(onChoose).not.toHaveBeenCalled();
});

it("shows only the open slideshow's own account, not another brand's backgrounds", async () => {
  await openPicker(
    [
      background("bg-1", "Our beach", "", "default"),
      background("bg-2", "Their skyline", "", "other-account"),
    ],
    { accountId: "default" },
  );

  await expect.element(page.getByRole("button", { name: "Our beach" })).toBeVisible();
  expect(page.getByRole("button", { name: "Their skyline" }).query()).toBe(null);
});
