import { useCallback, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import {
  OUTPUT_WIDTH,
  constrainImagePosition,
  outputHeight,
} from "@shared/geometry/index.js";
import type { LibraryItem, Slide } from "@shared/schema/index.js";
import {
  Button,
  Dialog,
  DropdownMenu,
  Icon,
  IconButton,
  useToast,
} from "../../design/index.js";
import { libraryCache } from "../../app/useLibrary.js";
import type { LibraryCache } from "../../app/useLibrary.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import { uploadBackgroundItem } from "./backgrounds.js";
import type { BackgroundUploader } from "./backgrounds.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import { useSlideThumbnail } from "./useSlideThumbnail.js";
import type { ThumbnailRenderer } from "./useSlideThumbnail.js";
import styles from "./SlideRail.module.css";

/*
 * The rail of slides down the left of the editor. Ported from renderSlideRail
 * (app.js:1557-1573), bindSlideReordering (app.js:3104-3150), reorderSlide
 * (app.js:3087-3103), showSlideMenu (app.js:718-757), removeSlide
 * (app.js:3044-3066) and handleSlideBackgroundChange (app.js:3009-3042).
 *
 * The hand-built right-click menu becomes a DropdownMenu on a real trigger. The
 * old one could not be opened from a keyboard at all, and it removed a slide on
 * the first click with nothing in between.
 */

/** app.js:3105. The drag payload, so a slide dropped elsewhere is ignored. */
const SLIDE_MIME = "application/x-slide-studio-slide";

type Placement = "before" | "after";

type DropTarget = { id: string; placement: Placement };

export type SlideRailProps = {
  store: EditorStore;
  /** Draws one thumbnail. Task 17 supplies it; without it the rail spins. */
  render?: ThumbnailRenderer | undefined;
  /**
   * Puts a chosen image in the library, for an upload made from inside the
   * picker. Injected so a test needs no server.
   */
  uploadBackground?: BackgroundUploader | undefined;
  /**
   * The library the whole app resolves images through. A replaced background
   * has to be folded in here, or the slide points at an item no renderer can
   * find and the stage goes blank (app.js:3026 wraps the upload in rememberItem).
   */
  library?: LibraryCache | undefined;
  /** The new slide button, whose upload flow is Task 15's. */
  /*
   * Required, not optional. It was optional, and the button read
   * `disabled={onAddSlide === undefined}`, so the one caller forgetting to pass
   * it turned into a control nobody could press and nothing could catch: it
   * rendered, it just never enabled. A required prop makes that a compile
   * error at the call site instead.
   */
  onAddSlide: () => void;
};

/** app.js:3092-3100, with the two lookups moved out so a no-op takes no undo entry. */
function moveSlide(
  slides: Slide[],
  sourceId: string,
  targetId: string,
  placement: Placement,
): void {
  const sourceIndex = slides.findIndex((slide) => slide.id === sourceId);
  if (sourceIndex < 0) return;
  const [moved] = slides.splice(sourceIndex, 1);
  if (moved === undefined) return;
  let targetIndex = slides.findIndex((slide) => slide.id === targetId);
  if (targetIndex < 0) {
    slides.splice(sourceIndex, 0, moved);
    return;
  }
  if (placement === "after") targetIndex += 1;
  slides.splice(targetIndex, 0, moved);
}

/** app.js:3125-3126. The half of the row the pointer is over decides the side. */
function placementFor(element: Element, clientY: number): Placement {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function SlideRail({
  store,
  render,
  uploadBackground = uploadBackgroundItem,
  library = libraryCache,
  onAddSlide,
}: SlideRailProps) {
  const { toast } = useToast();
  const slides = useEditor(store, (state) => state.project.slides);
  const ratio = useEditor(store, (state) => state.project.ratio);
  const activeSlideId = useEditor(store, (state) => state.activeSlideId);

  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  /*
   * The slide whose background is being replaced, which is also what holds the
   * picker open. app.js:3005 kept the same id on its module state, because the
   * choice arrives long after the menu item was pressed.
   */
  const [changingBackground, setChangingBackground] = useState<string | null>(null);
  // getData is unreadable during dragover under the browser's protected mode,
  // so the source id is held here too (app.js:3112 keeps state.draggingSlideId).
  const draggingId = useRef<string | null>(null);

  const reorder = useCallback(
    (sourceId: string, targetId: string, placement: Placement) => {
      if (sourceId === targetId) return;
      const current = store.getSnapshot().project.slides;
      const known = (id: string) => current.some((slide) => slide.id === id);
      // Both lookups happen before the mutation, so a drop that cannot land
      // takes no undo entry (app.js:3089-3093 checks in the same order).
      if (!known(sourceId) || !known(targetId)) return;
      store.mutate((document) => {
        moveSlide(document.slides, sourceId, targetId, placement);
      });
    },
    [store],
  );

  const removeSlide = useCallback(
    (slideId: string) => {
      const snapshot = store.getSnapshot();
      const index = snapshot.project.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) return;
      const wasActive = snapshot.activeSlideId === slideId;
      store.mutate((document) => {
        document.slides.splice(index, 1);
      });
      if (!wasActive) return;
      // app.js:3054 takes the slide that moved into the gap and falls back to
      // the one above it. The store's own repair would jump to the first slide.
      const remaining = store.getSnapshot().project.slides;
      const next = remaining[index] ?? remaining[index - 1];
      if (next !== undefined) store.setActiveSlide(next.id);
    },
    [store],
  );

  const applyBackground = useCallback(
    (items: readonly LibraryItem[]) => {
      const slideId = changingBackground;
      const item = items[0];
      setChangingBackground(null);
      if (slideId === null || item === undefined) return;
      if (!store.getSnapshot().project.slides.some((slide) => slide.id === slideId))
        return;
      // Before the document points at it. Every render path resolves
      // backgroundItemId through this cache without awaiting, so a slide that
      // names an item the cache has not seen paints nothing at all. An upload
      // is already in there, and re-publishing it would re-render every screen
      // holding the library for no change at all.
      if (library.get(item.id) === null) library.remember(item);
      store.mutate((document) => {
        const slide = document.slides.find((item_) => item_.id === slideId);
        if (slide === undefined) return;
        slide.backgroundItemId = item.id;
        slide.width = item.width;
        slide.height = item.height;
        // A new photo of a different shape can leave the old pan outside the
        // cover, which would show a gap (app.js:3033).
        const held = constrainImagePosition(
          slide,
          OUTPUT_WIDTH,
          outputHeight(document.ratio),
        );
        slide.imageX = held.imageX;
        slide.imageY = held.imageY;
      });
      toast("Slide background changed");
    },
    [changingBackground, library, store, toast],
  );

  const clearDrag = useCallback(() => {
    draggingId.current = null;
    setDragging(null);
    setDropTarget(null);
  }, []);

  const pendingIndex = slides.findIndex((slide) => slide.id === pendingRemoval);
  const pending = pendingIndex < 0 ? null : slides[pendingIndex];

  return (
    <aside
      className={styles.rail}
      aria-label="Slides"
      style={
        { "--thumb-aspect": `${String(ratio.w)} / ${String(ratio.h)}` } as CSSProperties
      }
    >
      <div className={styles.heading}>
        <h2>Slides</h2>
        <span className={styles.count}>{slides.length}</span>
      </div>

      <div className={styles.list} data-testid="slide-list">
        {slides.map((slide, index) => {
          const classes = [
            styles.slide,
            slide.id === activeSlideId ? styles.active : "",
            slide.id === dragging ? styles.dragging : "",
            dropTarget?.id === slide.id && dropTarget.placement === "before"
              ? styles.dropBefore
              : "",
            dropTarget?.id === slide.id && dropTarget.placement === "after"
              ? styles.dropAfter
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={slide.id}
              className={classes}
              data-slide-id={slide.id}
              draggable
              onDragStart={(event: ReactDragEvent<HTMLDivElement>) => {
                event.stopPropagation();
                draggingId.current = slide.id;
                setDragging(slide.id);
                event.dataTransfer.setData(SLIDE_MIME, slide.id);
                event.dataTransfer.setData("text/plain", `slide:${slide.id}`);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
                const source = draggingId.current;
                if (source === null || source === slide.id) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                const placement = placementFor(event.currentTarget, event.clientY);
                setDropTarget((current) =>
                  current?.id === slide.id && current.placement === placement
                    ? current
                    : { id: slide.id, placement },
                );
              }}
              onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
                const source =
                  event.dataTransfer.getData(SLIDE_MIME) || draggingId.current;
                if (source === null || source === "" || source === slide.id) return;
                event.preventDefault();
                event.stopPropagation();
                const placement = placementFor(event.currentTarget, event.clientY);
                clearDrag();
                reorder(source, slide.id, placement);
              }}
              onDragEnd={clearDrag}
            >
              <button
                type="button"
                className={styles.open}
                aria-label={`Open slide ${String(index + 1)}`}
                aria-current={slide.id === activeSlideId ? "true" : undefined}
                title="Drag to reorder"
                onClick={() => {
                  store.setActiveSlide(slide.id);
                }}
              >
                <span className={styles.number}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <SlideThumbnail slide={slide} ratio={ratio} render={render} />
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton
                    className={styles.menu}
                    icon="down"
                    size="sm"
                    label={`Actions for slide ${String(index + 1)}`}
                  />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content compact align="end">
                  <DropdownMenu.Item
                    icon="image"
                    onSelect={() => {
                      setChangingBackground(slide.id);
                    }}
                  >
                    Change
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    danger
                    icon="trash"
                    onSelect={() => {
                      setPendingRemoval(slide.id);
                    }}
                  >
                    Remove
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          );
        })}
      </div>

      <div className={styles.footer}>
        {/*
         * Labelled on the button itself, not by the text inside it. The narrow
         * rail hides that text and the icon is decoration, which left the
         * control with no accessible name at all below 780px: visible to a
         * sighted reader, invisible to everyone else.
         */}
        <Button variant="ghost" onClick={onAddSlide} aria-label="New slide">
          <Icon name="plus" />
          <span>New slide</span>
        </Button>
      </div>

      <BackgroundPicker
        open={changingBackground !== null}
        onOpenChange={(open) => {
          if (!open) setChangingBackground(null);
        }}
        title="Change background"
        description="Choose a background from your library, or upload a new image."
        onChoose={applyBackground}
        cache={library}
        upload={uploadBackground}
      />

      <Dialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <Dialog.Content compact role="alertdialog">
          <Dialog.Title>Remove slide?</Dialog.Title>
          <Dialog.Description>
            Slide {String(pendingIndex + 1)} and everything on it will be taken out of
            this slideshow.
          </Dialog.Description>
          <Dialog.Actions>
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="danger"
              onClick={() => {
                if (pending != null) removeSlide(pending.id);
                setPendingRemoval(null);
              }}
            >
              Remove slide
            </Button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Root>
    </aside>
  );
}

type SlideThumbnailProps = {
  slide: Slide;
  ratio: { w: number; h: number };
  render?: ThumbnailRenderer | undefined;
};

/** app.js:1575-1579. The picture, or the spinner that stands in for it. */
function SlideThumbnail({ slide, ratio, render }: SlideThumbnailProps) {
  const url = useSlideThumbnail(slide, { ratio, render });
  return (
    <span className={styles.thumb}>
      {url === null ? (
        <span className={styles.pending} aria-hidden="true">
          <span />
        </span>
      ) : (
        <img src={url} alt="" draggable={false} aria-hidden="true" />
      )}
    </span>
  );
}
