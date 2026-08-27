import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { LibraryItem, LibrarySort } from "@shared/schema/index.js";
import { Button, Dialog, Icon, Input, Select } from "../../design/index.js";
import type { SelectOption } from "../../design/index.js";
import { libraryCache, useLibrary } from "../../app/useLibrary.js";
import type { LibraryCache } from "../../app/useLibrary.js";
import { browseLibrary } from "../library/browse.js";
import { IMAGE_ACCEPT, isImageFile } from "../library/upload.js";
import { uploadBackgroundItem } from "./backgrounds.js";
import styles from "./BackgroundPicker.module.css";

/*
 * Choosing a background, from the library or from a file.
 *
 * Both routes to a background were a file picker and nothing else: adding a
 * slide (addSlides.ts) and changing a slide's photo (SlideRail.tsx, ported from
 * app.js:3000-3043). A person who had curated a library of backgrounds could
 * not use one, and had to re-upload an image they already owned. The premise of
 * the product is that a human curates the library and an agent draws from it,
 * so the human being locked out of it was the gap.
 *
 * One picker serves both callers. It returns the chosen item and nothing else,
 * because adding a slide and replacing a photo do different things with it.
 */

/** The three the server orders by (src/server/services/library.ts:22-27). */
const SORTS: readonly SelectOption[] = [
  { value: "recent", label: "Recently updated" },
  { value: "least-used", label: "Least used" },
  { value: "most-used", label: "Most used" },
];

export type BackgroundPickerProps = {
  open: boolean;
  /** Radix reports both directions here, so a click outside closes it too. */
  onOpenChange: (open: boolean) => void;
  /** The heading. One picker adds a slide and replaces a photo, so it varies. */
  title: string;
  description: string;
  /**
   * The chosen backgrounds, in the order they were chosen, and never empty.
   *
   * A batch rather than one item, because the New slide button has always taken
   * several images at once and made a slide of each. Replacing one slide's
   * photo passes `multiple={false}` and reads the first.
   */
  onChoose: (items: readonly LibraryItem[]) => void;
  /** Whether an upload may take several files. A replacement takes one. */
  multiple?: boolean | undefined;
  /** The app's one cache by default. A test builds its own over a fake server. */
  cache?: LibraryCache | undefined;
  /** Puts a chosen file in the library. Injected so a test needs no server. */
  upload?: ((file: File) => Promise<LibraryItem>) | undefined;
  /**
   * The open slideshow's own account. Both the browsable pool and the upload
   * default are scoped to it, so nothing from another brand shows up here:
   * every real caller (SlideRail, Editor) knows its project's account and
   * passes it.
   */
  accountId: string;
};

export function BackgroundPicker({
  open,
  onOpenChange,
  title,
  description,
  onChoose,
  multiple = false,
  cache = libraryCache,
  accountId,
  upload: uploadProp,
}: BackgroundPickerProps) {
  // Kept stable across renders by keying it on `accountId` rather than
  // building it fresh every render (a fresh function every render used to
  // defeat every callback downstream that depends on `upload`, here and in
  // the callers that build their own default the same way).
  const defaultUpload = useCallback(
    (file: File) => uploadBackgroundItem(file, accountId),
    [accountId],
  );
  const upload = uploadProp ?? defaultUpload;
  // Scoped to the same accountId Editor.tsx already loads this same cache
  // instance with (both pass `cache={library}` — Editor.tsx, SlideRail.tsx).
  // Calling this unscoped used to make `loadedAccountId` a race between the
  // two effects: whichever fired last decided what the whole shared cache
  // held, so on an unlucky ordering this picker (and everything else reading
  // the cache) silently fell back to the unscoped, cross-account page the
  // scoping exists to prevent.
  const { items, loading } = useLibrary(cache, accountId);
  // Redundant once the load above is itself scoped, but cheap insurance
  // against exactly the kind of stale cross-account item a race here used to
  // let through.
  const ownItems = useMemo(
    () => new Map([...items].filter(([, item]) => item.accountId === accountId)),
    [items, accountId],
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  /*
   * Every close comes through here, whichever way it was asked for: Cancel,
   * Escape, a click outside, or a background being chosen. The search and the
   * failure notice are cleared on the way out rather than on the way in,
   * because the picker only ever hears about closing. A search left over would
   * hide the whole library the next time this is opened.
   */
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery("");
        setProblem(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const shown = useMemo(
    () => browseLibrary(ownItems.values(), { kind: "background", query, sort }),
    [ownItems, query, sort],
  );

  // Whether the account's own library holds any background at all, which is a
  // different emptiness from a search that matched none of them.
  const anyBackground = useMemo(
    () => [...ownItems.values()].some((item) => item.kind === "background"),
    [ownItems],
  );

  const choose = useCallback(
    (items: readonly LibraryItem[]) => {
      if (items.length === 0) return;
      onChoose(items);
      changeOpen(false);
    },
    [changeOpen, onChoose],
  );

  const onFilesChosen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.currentTarget.files ?? [])];
      // Cleared first, so choosing the same file twice still fires a change.
      event.currentTarget.value = "";
      const images = files.filter(isImageFile);
      if (images.length === 0) {
        // A picker the reader closed says nothing, because they asked for
        // nothing. A file that is not an image is a mistake worth naming.
        if (files.length > 0) setProblem("Choose an image file.");
        return;
      }
      const run = async () => {
        setUploading(true);
        setProblem(null);
        const added: LibraryItem[] = [];
        for (const file of images) {
          try {
            const item = await upload(file);
            // Into the cache before any caller names it. Every render resolves
            // a background through the cache without awaiting, so a slide
            // pointing at an item the cache has not seen paints nothing.
            cache.remember(item);
            added.push(item);
          } catch (error) {
            // app.js:4167. One bad file does not take the batch with it.
            console.error(error);
          }
        }
        setUploading(false);
        if (added.length === 0) {
          setProblem(
            images.length === 1
              ? "That image couldn’t be uploaded."
              : "Those images couldn’t be uploaded.",
          );
          return;
        }
        choose(added);
      };
      void run();
    },
    [cache, choose, upload],
  );

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Content>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>

        {/*
         * Sticky, because the panel is what scrolls. A library of forty
         * backgrounds would otherwise carry the search box off the top.
         */}
        <div className={styles.toolbar}>
          <Input
            className={styles.search ?? ""}
            type="search"
            value={query}
            placeholder="Search name, description, usage or tags"
            aria-label="Search backgrounds"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
          />
          <Select
            items={SORTS}
            value={sort}
            aria-label="Order"
            onValueChange={(value) => {
              // The value can only be one of the three above, and
              // librarySortSchema repairs anything else as the server does.
              setSort(value as LibrarySort);
            }}
          />
        </div>

        {problem === null ? null : (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}

        <div className={styles.grid} aria-label="Background library">
          {shown.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.tile}
              data-item-id={item.id}
              title={
                item.description === "" ? item.name : `${item.name} — ${item.description}`
              }
              onClick={() => {
                choose([item]);
              }}
            >
              {/* Named by the caption below, so the alt would only say it twice. */}
              <img src={item.url} alt="" loading="lazy" />
              <span className={styles.name}>{item.name}</span>
            </button>
          ))}
        </div>

        {shown.length > 0 ? null : (
          <p className={styles.empty}>
            {loading
              ? "Loading your backgrounds…"
              : anyBackground
                ? "Nothing matches that search."
                : "No backgrounds in your library yet. Upload one below and it joins the library, ready for the next slideshow."}
          </p>
        )}

        <Dialog.Actions>
          <input
            ref={picker}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple={multiple}
            hidden
            onChange={onFilesChosen}
          />
          <Button
            busy={uploading}
            onClick={() => {
              picker.current?.click();
            }}
          >
            <Icon name="plus" />
            <span>
              {uploading ? "Uploading…" : multiple ? "Upload images" : "Upload an image"}
            </span>
          </Button>
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
        </Dialog.Actions>
      </Dialog.Content>
    </Dialog.Root>
  );
}
