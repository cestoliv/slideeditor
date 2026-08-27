import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { LibraryItem } from "@shared/schema/index.js";
import { Button, Icon, Input, useToast } from "../../design/index.js";
import { libraryCache } from "../../app/useLibrary.js";
import type { LibraryCache, LibraryIndex } from "../../app/useLibrary.js";
import { matchesQuery } from "../library/browse.js";
import { IMAGE_ACCEPT, isImageFile } from "../library/upload.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import { projectAssetIds, removeProjectAsset } from "./layers/actions.js";
import {
  ASSET_DRAG_TYPE,
  assetDragProps,
  uploadAssetFile,
} from "./layers/useAssetDrop.js";
import { TRASH_ATTRIBUTE, TRASH_HOT_ATTRIBUTE } from "./layers/trash.js";
import styles from "./AssetRail.module.css";

/*
 * The asset rail. Ported from renderAssetRail (app.js:1646-1681),
 * bindAssetLibrary (app.js:3151-3206), showAssetPreview and hideAssetPreview
 * (app.js:3208-3229), bindAssetTrash (app.js:3231-3253) and deleteProjectAsset
 * (app.js:3446-3457), with styles.css:543-870.
 *
 * Without it there is no way for a person to put a curated library asset on a
 * slide at all: dropping a file from the desktop and pasting one are the only
 * routes, and choosing from the library is an agent-only capability. That
 * inverts the premise that a human curates the library.
 *
 * app.js debounced the search by 180ms and then re-focused the input and
 * restored its caret (app.js:3195-3200, subtlety 21). Both existed because
 * typing re-rendered the whole editor and destroyed the input. The value is
 * React state here, the input is never replaced, and the filter is a substring
 * test over a cache that is already in memory, so neither is ported.
 */

/** app.js:3210-3212. How far the hover preview sits from the pointer, and how big. */
const PREVIEW_PAD = 16;
const PREVIEW_SIZE = 240;
const PREVIEW_EDGE = 8;

type Source = "project" | "all";

type Preview = { src: string; alt: string; left: number; top: number };

export type AssetRailProps = {
  store: EditorStore;
  /** The resolved library, which every tile draws through. */
  library: LibraryIndex;
  /** The cache itself, so an upload is visible without a round trip. */
  cache?: LibraryCache | undefined;
  /** Puts a chosen file in the library. Injected so a test needs no server. */
  upload?: ((file: File, name: string) => Promise<LibraryItem>) | undefined;
};

/** app.js:3213-3220. Beside the pointer, flipped and clamped to stay on screen. */
function previewPosition(
  clientX: number,
  clientY: number,
): { left: number; top: number } {
  let left = clientX + PREVIEW_PAD;
  let top = clientY + PREVIEW_PAD;
  if (left + PREVIEW_SIZE > window.innerWidth - PREVIEW_EDGE) {
    left = clientX - PREVIEW_SIZE - PREVIEW_PAD;
  }
  if (top + PREVIEW_SIZE > window.innerHeight - PREVIEW_EDGE) {
    top = clientY - PREVIEW_SIZE - PREVIEW_PAD;
  }
  return { left: Math.max(PREVIEW_EDGE, left), top: Math.max(PREVIEW_EDGE, top) };
}

export function AssetRail({
  store,
  library,
  cache = libraryCache,
  upload,
}: AssetRailProps) {
  const { toast } = useToast();
  const project = useEditor(store, (state) => state.project);
  const [source, setSource] = useState<Source>("project");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [trashHot, setTrashHot] = useState(false);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  const assets = useMemo(() => {
    const pool =
      source === "all"
        ? // Only the project's own account's assets: browsing another brand's
          // images from inside a slideshow would let one of them get saved
          // into it (validateComposition/validateDocumentAccountScope reject
          // the save, but the picker should not offer them in the first place).
          [...library.values()].filter(
            (item) => item.kind === "asset" && item.accountId === project.accountId,
          )
        : projectAssetIds(project).flatMap((id) => {
            const item = library.get(id);
            return item === undefined ? [] : [item];
          });
    return pool.filter((item) => matchesQuery(item, query));
  }, [library, project, query, source]);

  const hidePreview = useCallback(() => {
    setPreview(null);
  }, []);

  const showPreview = useCallback(
    (item: LibraryItem, event: ReactPointerEvent) => {
      // app.js:3156. A drag has its own image; a preview beside it is noise.
      if (dragging !== null) {
        setPreview(null);
        return;
      }
      setPreview({
        src: item.url,
        alt: item.name,
        ...previewPosition(event.clientX, event.clientY),
      });
    },
    [dragging],
  );

  /** app.js:3235. Either the rail's own drag, or one carrying an asset id. */
  const isAssetDrag = useCallback(
    (event: ReactDragEvent) =>
      dragging !== null || [...event.dataTransfer.types].includes(ASSET_DRAG_TYPE),
    [dragging],
  );

  const onTrashDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setTrashHot(false);
      const payload =
        event.dataTransfer.getData(ASSET_DRAG_TYPE) ||
        event.dataTransfer.getData("text/plain") ||
        dragging ||
        "";
      const itemId = payload.startsWith("asset:") ? payload.slice(6) : payload;
      setDragging(null);
      if (itemId === "") return;
      const item = library.get(itemId);
      if (removeProjectAsset(store, itemId)) {
        toast(`${item?.name ?? "That asset"} removed from this slideshow`);
      }
    },
    [dragging, library, store, toast],
  );

  const onFilesChosen = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile);
      if (images.length === 0 || uploading) return;
      setUploading(true);
      try {
        const added: LibraryItem[] = [];
        for (const [index, file] of images.entries()) {
          try {
            const item = await (
              upload ??
              ((f: File, name: string) => uploadAssetFile(f, name, project.accountId))
            )(file, images.length > 1 ? `Asset ${String(index + 1)}` : "Asset");
            cache.remember(item);
            added.push(item);
          } catch (error) {
            console.error(error);
          }
        }
        if (added.length === 0) {
          toast("Those assets couldn’t be uploaded.", { tone: "danger" });
          return;
        }
        // app.js:3419. A fresh upload is in the library, not on the slideshow,
        // so the rail switches to the view that can show it.
        setSource("all");
        toast(
          `${String(added.length)} ${added.length === 1 ? "asset" : "assets"} uploaded`,
        );
      } finally {
        setUploading(false);
      }
    },
    [cache, project.accountId, toast, upload, uploading],
  );

  return (
    <aside className={styles.rail} aria-label="Assets">
      <div className={styles.heading}>
        <h2>Assets</h2>
        <span aria-hidden="true">{assets.length}</span>
      </div>

      <div className={styles.scope} role="group" aria-label="Asset source">
        <button
          type="button"
          className={styles.scopeButton}
          aria-pressed={source === "project"}
          onClick={() => {
            setSource("project");
          }}
        >
          In use
        </button>
        <button
          type="button"
          className={styles.scopeButton}
          aria-pressed={source === "all"}
          onClick={() => {
            setSource("all");
          }}
        >
          Library
        </button>
      </div>

      <Input
        className={styles.search ?? ""}
        type="search"
        value={query}
        placeholder="Search assets"
        aria-label="Search the asset library"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />

      <div className={styles.grid} aria-label="Asset library">
        {assets.length === 0 ? (
          <p className={styles.empty}>
            {source === "all"
              ? "The asset library is empty. Upload logos, stickers, or extra photos."
              : "No assets on this slideshow yet. Switch to Library and drag one onto the photo."}
          </p>
        ) : (
          assets.map((item) => (
            <div
              key={item.id}
              className={styles.item}
              data-item-id={item.id}
              data-dragging={dragging === item.id ? "true" : undefined}
              title={
                item.description === "" ? item.name : `${item.name} — ${item.description}`
              }
              {...assetDragProps(item.id)}
              onDragStart={(event) => {
                hidePreview();
                setDragging(item.id);
                assetDragProps(item.id).onDragStart(event);
              }}
              onDragEnd={() => {
                setDragging(null);
                setTrashHot(false);
                hidePreview();
              }}
              onPointerEnter={(event) => {
                showPreview(item, event);
              }}
              onPointerMove={(event) => {
                showPreview(item, event);
              }}
              onPointerLeave={hidePreview}
            >
              <img src={item.url} alt={item.name} draggable={false} loading="lazy" />
            </div>
          ))
        )}
      </div>

      {/*
       * Two different drags land here, and both must work. An overlay dragged
       * off the canvas with the pointer is found through TRASH_ATTRIBUTE by
       * layers/trash.ts, which sets TRASH_HOT_ATTRIBUTE itself; an asset
       * dragged out of the grid above arrives as an HTML5 drag.
       */}
      <div
        className={styles.trash}
        data-testid="asset-trash"
        data-hot={trashHot ? "true" : undefined}
        {...{ [TRASH_ATTRIBUTE]: "" }}
        onDragOver={(event) => {
          if (!isAssetDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setTrashHot(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setTrashHot(false);
        }}
        onDrop={onTrashDrop}
      >
        <Icon name="trash" />
        <span>Drag here to remove</span>
      </div>

      <div className={styles.actions}>
        <input
          ref={picker}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void onFilesChosen(files);
          }}
        />
        <Button
          variant="ghost"
          disabled={uploading}
          onClick={() => {
            picker.current?.click();
          }}
        >
          <Icon name="plus" />
          <span>{uploading ? "Uploading…" : "Upload assets"}</span>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/library/assets">
            <Icon name="edit" />
            <span>Manage library</span>
          </Link>
        </Button>
      </div>

      {/*
       * Portalled, because the rail carries a backdrop-filter and that makes it
       * the containing block for any fixed descendant, which would trap the
       * preview inside a 168px column.
       */}
      {preview === null
        ? null
        : createPortal(
            <img
              className={styles.preview}
              data-testid="asset-preview"
              src={preview.src}
              alt=""
              aria-hidden="true"
              style={{
                left: `${String(preview.left)}px`,
                top: `${String(preview.top)}px`,
              }}
            />,
            document.body,
          )}
    </aside>
  );
}

export { TRASH_HOT_ATTRIBUTE };
