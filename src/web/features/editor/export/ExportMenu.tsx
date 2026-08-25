import { useCallback, useRef, useState } from "react";
import { outputHeight } from "@shared/geometry/index.js";
import type { Project, Slide } from "@shared/schema/index.js";
import { Button, Icon, useToast } from "../../../design/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { activeSlideOf, useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { downloadBlob, slideExportName, zipExportName } from "./download.js";
import { renderSlideBlob } from "./render.js";
import {
  canShareFiles,
  hasUserActivation,
  isAbort,
  isNotAllowed,
  shareFiles,
} from "./share.js";
import { zipBlob } from "./zip.js";

/*
 * The four export actions, ported from the header buttons at app.js:1215-1226
 * and from exportActiveSlide, exportAllSlides, shareActiveSlide and
 * shareAllSlides (app.js:4252-4402).
 *
 * app.js disabled the buttons by hand, swapped their innerHTML for a progress
 * string and put the old markup back in a finally block. One piece of state
 * carries both here, so a render that never happens cannot leave a button
 * saying "Zipping…" forever.
 */

/** Which action is running. Only one runs at a time, as in app.js. */
type Action = "png" | "zip" | "share" | "share-all";

type Progress = { action: Action; label: string };

/**
 * Whether this browser puts files on the share sheet at all.
 *
 * navigator.canShare wants a file to answer about, so it is asked about a
 * stand-in rather than about a render nobody has asked for yet. The answer is
 * the same for every PNG, and it decides whether the two AirDrop buttons exist.
 */
const PROBE_FILE = new File([new Uint8Array([137, 80, 78, 71])], "slide.png", {
  type: "image/png",
});

/**
 * Everything the cached files were built from.
 *
 * app.js keyed its cache on the project id and updatedAt (app.js:4360-4362).
 * updatedAt only moves when the server answers a save, so an edit made since
 * the last one left the key unchanged and the cache served the previous
 * render. The document itself is the thing the files have to still match, so
 * that is what is compared.
 */
function documentSignature(project: Project): string {
  return JSON.stringify([project.name, project.ratio, project.slides]);
}

type ShareCache = { signature: string; files: File[] };

export type ExportMenuProps = {
  store: EditorStore;
  /** Resolves every background and overlay the render draws. */
  library: LibraryIndex;
};

export function ExportMenu({ store, library }: ExportMenuProps) {
  const { toast } = useToast();
  const project = useEditor(store, (state) => state.project);
  const slide = useEditor(store, activeSlideOf);
  const [progress, setProgress] = useState<Progress | null>(null);
  const shareAllCache = useRef<ShareCache | null>(null);
  /*
   * Read once, at mount. navigator.canShare cannot change under a live page,
   * and asking during render would build a File on every keystroke in the
   * slideshow's name.
   */
  const [sharing] = useState(() => canShareFiles([PROBE_FILE]));

  const slideCount = project.slides.length;
  const busy = progress !== null;
  const height = outputHeight(project.ratio);

  const renderOne = useCallback(
    (target: Slide) => renderSlideBlob(target, { height, assets: library }),
    [height, library],
  );

  /**
   * Renders every slide, reporting which one is in flight.
   *
   * app.js wrote the count into the button it had just disabled. The label is
   * state here, so the caller decides which button wears it.
   */
  const renderAll = useCallback(
    async (action: Action, verb: string): Promise<{ slide: Slide; blob: Blob }[]> => {
      const done: { slide: Slide; blob: Blob }[] = [];
      for (const [index, target] of project.slides.entries()) {
        setProgress({
          action,
          label: `${verb}${String(index + 1)}/${String(slideCount)}…`,
        });
        done.push({ slide: target, blob: await renderOne(target) });
      }
      return done;
    },
    [project.slides, renderOne, slideCount],
  );

  const exportActiveSlide = useCallback(async () => {
    if (slide === null) return;
    setProgress({ action: "png", label: "Rendering…" });
    try {
      const blob = await renderOne(slide);
      downloadBlob(blob, slideExportName(slide, project.name));
      toast("PNG downloaded at full resolution");
    } catch (error) {
      console.error(error);
      toast("The image couldn’t be downloaded.", { tone: "danger" });
    } finally {
      setProgress(null);
    }
  }, [project.name, renderOne, slide, toast]);

  const exportAllSlides = useCallback(async () => {
    if (slideCount === 0) return;
    try {
      const rendered = await renderAll("zip", "");
      setProgress({ action: "zip", label: "Zipping…" });
      const entries = await Promise.all(
        rendered.map(async (entry, index) => ({
          name: slideExportName(entry.slide, project.name, index),
          data: new Uint8Array(await entry.blob.arrayBuffer()),
        })),
      );
      downloadBlob(zipBlob(entries), zipExportName(project.name));
      toast(
        `${String(entries.length)} ${entries.length === 1 ? "slide" : "slides"} downloaded as a ZIP`,
      );
    } catch (error) {
      console.error(error);
      toast("The ZIP couldn’t be created.", { tone: "danger" });
    } finally {
      setProgress(null);
    }
  }, [project.name, renderAll, slideCount, toast]);

  const shareActiveSlide = useCallback(async () => {
    if (slide === null) return;
    setProgress({ action: "share", label: "Preparing…" });
    try {
      const blob = await renderOne(slide);
      const file = new File([blob], slideExportName(slide, project.name), {
        type: "image/png",
      });
      if (!canShareFiles([file])) {
        /*
         * app.js:4331-4340 had a third branch here: where navigator.share
         * existed but refused files, it shared an object URL instead. That
         * branch is deleted rather than ported, and this is the only place the
         * port drops a behaviour.
         *
         * It could not work. The URL it shared was a blob: URL scoped to this
         * origin and revoked a second later, so whatever the recipient received
         * resolved to nothing on their machine. The reader was told the share
         * had happened and no image ever arrived, which is worse than being
         * told to use Download PNG. This button is also only on screen when the
         * probe at mount already said files are shareable, so the branch was
         * close to unreachable besides.
         */
        toast("Sharing isn’t available in this browser. Use Download PNG.");
        return;
      }
      await shareFiles([file], project.name);
    } catch (error) {
      if (isAbort(error)) return;
      console.error(error);
      toast("Couldn’t open the share menu.", { tone: "danger" });
    } finally {
      setProgress(null);
    }
  }, [project.name, renderOne, slide, toast]);

  const shareAllSlides = useCallback(async () => {
    if (slideCount === 0) return;
    try {
      const signature = documentSignature(project);
      const held = shareAllCache.current;
      let files = held !== null && held.signature === signature ? held.files : null;
      if (files === null) {
        const rendered = await renderAll("share-all", "Preparing ");
        files = rendered.map(
          (entry, index) =>
            new File([entry.blob], slideExportName(entry.slide, project.name, index), {
              type: "image/png",
            }),
        );
        // Held before the sheet is asked for, because rendering a slideshow's
        // worth of PNGs outlasts the press that started it and Safari then
        // refuses. The reader presses again and the files are already here.
        shareAllCache.current = { signature, files };
      }
      if (!canShareFiles(files)) {
        shareAllCache.current = null;
        toast("This browser can’t share multiple images at once.");
        return;
      }
      if (!hasUserActivation()) {
        toast("Slides are ready — tap AirDrop all again.");
        return;
      }
      await shareFiles(files, project.name);
      shareAllCache.current = null;
    } catch (error) {
      if (isAbort(error)) return;
      if (isNotAllowed(error) && shareAllCache.current !== null) {
        toast("Slides are ready — tap AirDrop all again.");
        return;
      }
      shareAllCache.current = null;
      console.error(error);
      toast("Couldn’t open the share menu for all slides.", { tone: "danger" });
    } finally {
      setProgress(null);
    }
  }, [project, renderAll, slideCount, toast]);

  const labelFor = (action: Action, resting: string): string =>
    progress?.action === action ? progress.label : resting;

  return (
    <>
      {sharing ? (
        <>
          <Button
            variant="ghost"
            aria-label="AirDrop current slide"
            title="AirDrop current slide"
            disabled={slide === null || busy}
            onClick={() => {
              void shareActiveSlide();
            }}
          >
            <span>{labelFor("share", "AirDrop")}</span>
          </Button>
          <Button
            variant="ghost"
            aria-label="AirDrop all slides"
            title="AirDrop all slides"
            disabled={slideCount === 0 || busy}
            onClick={() => {
              void shareAllSlides();
            }}
          >
            <span>{labelFor("share-all", "AirDrop all")}</span>
          </Button>
        </>
      ) : null}
      <Button
        variant="ghost"
        aria-label="Download current slide as PNG"
        title="Download PNG"
        disabled={slide === null || busy}
        onClick={() => {
          void exportActiveSlide();
        }}
      >
        <Icon name="download" />
        <span>{labelFor("png", "PNG")}</span>
      </Button>
      <Button
        variant="ghost"
        aria-label="Download all slides as a ZIP"
        title="Download all slides as a ZIP"
        disabled={slideCount === 0 || busy}
        onClick={() => {
          void exportAllSlides();
        }}
      >
        <Icon name="archive" />
        <span>{labelFor("zip", "ZIP")}</span>
      </Button>
    </>
  );
}
