import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BUILTIN_DEFAULTS } from "@shared/schema/index.js";
import type { LibraryItem, Project, SlideshowStatus } from "@shared/schema/index.js";
import { Badge, Button, Icon, IconButton, Input, useToast } from "../../design/index.js";
import { api, persistProject } from "../../app/api.js";
import { useAccounts } from "../../app/accounts.js";
import { subscribeToServerEvents } from "../../app/events.js";
import type { ServerEvent } from "../../app/events.js";
import { libraryCache, useLibrary } from "../../app/useLibrary.js";
import type { LibraryCache } from "../../app/useLibrary.js";
import { Header } from "../shell/Header.js";
import { EditorStore, activeSlideOf, useEditor } from "./store.js";
import type { SetStatusFn } from "./store.js";
import type { SaveFn, SaveState } from "./persistence.js";
import { addSlidesFromItems } from "./addSlides.js";
import { AssetRail } from "./AssetRail.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import { uploadBackgroundItem } from "./backgrounds.js";
import { SaveIndicator } from "./SaveIndicator.js";
import { SlideRail } from "./SlideRail.js";
import { Stage } from "./Stage.js";
// Task 16. The inspector, the ratio and overlay menus, and the status switch.
import { Inspector } from "./Inspector/Inspector.js";
import { PreviewMenu } from "./PreviewMenu.js";
import { RatioMenu } from "./RatioMenu.js";
import { StatusSwitch } from "./StatusSwitch.js";
// The caption the slideshow is posted with, beside the name and the status
// because it belongs to the slideshow rather than to the slide on screen.
import { CaptionPanel } from "./CaptionPanel.js";
import { PreviewChrome } from "./chrome/PreviewChrome.js";
import type { ChromeId } from "./chrome/chrome.js";
// Task 15. The layer stack and the crop session it owns.
import { useLayerStack } from "./layers/LayerStack.js";
import { uploadAssetFile } from "./layers/useAssetDrop.js";
import type { ThumbnailRenderer } from "./useSlideThumbnail.js";
// Task 17. The export actions in the header, and the renderer the rail draws with.
import { ExportMenu } from "./export/ExportMenu.js";
import { renderSlideBlob } from "./export/render.js";
import { usePublishOnReady } from "./export/usePublishOnReady.js";
import styles from "./Editor.module.css";

/*
 * The editor frame: the header, the slide rail, and the stage. Ported from
 * renderEditor (app.js:1516-1554) and the parts of bindEditorEvents that belong
 * to the frame rather than to a layer (app.js:2158-2163, app.js:2197-2203,
 * app.js:2244-2249), plus handleServerEvent (app.js:1121-1140).
 *
 * The asset rail is Task 15's and hangs its own column off Editor.module.css
 * when it lands. Task 16's inspector is the trailing column already.
 */

/**
 * True while the document differs from the server's copy: the debounce is
 * counting down, a write is on the wire, or one failed and nothing retries it.
 * Both the reload deferral and the unload guard read this, so the two cannot
 * disagree about what counts as unsaved.
 */
function isOwedWrite(state: SaveState): boolean {
  return state === "pending" || state === "saving";
}

/**
 * How long a deferred reload waits for the write blocking it. Past this the
 * write is not coming: the save failed and nothing retries it, or it is stuck
 * on the wire. Long enough that no ordinary save comes near it, since the
 * debounce is four hundred milliseconds and a save is one request.
 */
export const STALE_NOTICE_MS = 10_000;

export type EditorClient = {
  getProject: (id: string) => Promise<{ project: Project }>;
  save: SaveFn;
  setStatus: SetStatusFn;
};

const defaultClient: EditorClient = {
  getProject: (id) => api.getProject(id),
  save: persistProject,
  setStatus: (id, status: SlideshowStatus) => api.setProjectStatus(id, status),
};

export type EditorProps = {
  projectId: string;
  client?: EditorClient | undefined;
  library?: LibraryCache | undefined;
  /** The server-sent stream, so a test can push a frame without a server. */
  subscribe?: ((onEvent: (event: ServerEvent) => void) => () => void) | undefined;
  /** Draws a slide thumbnail. Task 17 supplies it. */
  render?: ThumbnailRenderer | undefined;
};

/*
 * The id travels with the state, so a navigation between two slideshows shows
 * the loading screen by derivation rather than by a setState in an effect body,
 * which would cascade a render on every open.
 */
type Load = { id: string } & (
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; store: EditorStore }
);

export function Editor({
  projectId,
  client = defaultClient,
  library = libraryCache,
  subscribe = subscribeToServerEvents,
  render,
}: EditorProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Load>({ kind: "loading", id: projectId });
  const load: Load =
    loaded.id === projectId ? loaded : { kind: "loading", id: projectId };
  const store = load.kind === "ready" ? load.store : null;
  // Undefined until the project itself has loaded - the account is on its
  // document. A slideshow may only reference its own account's library
  // (validateComposition, server side), and the unscoped page this falls
  // back to while loading is one 200-item page across every account, so an
  // account with more than 200 items - or simply an older one - can be
  // entirely absent from it (Editor never renders anything from `items`
  // until `store` exists, so that transient unscoped read is never shown).
  const accountId = store?.getSnapshot().project.accountId;
  // app.js:1541-1543 refreshes the library alongside the project, because every
  // slide resolves its background through it. `ready: store !== null` is what
  // keeps a cold open from firing an unscoped load at all: before this,
  // `accountId` being undefined on the very first render (store not loaded
  // yet) fired a full 200-item unscoped, stats-joined query that was
  // discarded a render or two later once the real, scoped accountId came in.
  const { items } = useLibrary(library, accountId, store !== null);

  /*
   * Latched by the project.removed handler. Closing the editor flushes whatever
   * the save debounce still owes (EditorStore.dispose), and that write goes to
   * a slideshow the server has just deleted, so it fails. Reporting that on top
   * of "This slideshow was removed" tells the reader their work did not save
   * when there is nothing left to save it to.
   */
  const removed = useRef(false);

  /*
   * Raised by a save that did not land, and read when the save settles. A
   * write that failed never reached the server, so the edit it carried exists
   * only here: reloading over it would discard work the reader can still see
   * on screen, which is worse than the staleness the reload was meant to cure.
   */
  const saveFailed = useRef(false);

  const onError = useCallback(
    (error: unknown) => {
      // app.js:1096-1097 logs and toasts a failed save. Nothing else tells the
      // reader that their work is not on disk.
      console.error(error);
      saveFailed.current = true;
      if (removed.current) return;
      toast("Couldn’t save this slideshow.", { tone: "danger" });
    },
    [toast],
  );

  useEffect(() => {
    let live = true;
    let opened: EditorStore | null = null;
    void client
      .getProject(projectId)
      .then(({ project }) => {
        if (!live) return;
        opened = new EditorStore(project, {
          save: client.save,
          setStatus: client.setStatus,
          onError,
        });
        setLoaded({ kind: "ready", id: projectId, store: opened });
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!live) return;
        setLoaded({ kind: "failed", id: projectId });
      });
    return () => {
      live = false;
      const closing = opened;
      if (closing === null) return;
      // Awaited rather than merely called: dispose flushes whatever the
      // debounce still owes, and a caller that walks away from that promise
      // never learns the last edit failed to land.
      void (async () => {
        try {
          await closing.dispose();
        } catch (error) {
          console.error(error);
        }
      })();
    };
  }, [client, onError, projectId]);

  /*
   * handleServerEvent, app.js:1120-1143. An agent writing through the MCP
   * backend while a human has the slideshow open is the normal case on this
   * app, not an error condition, so all three frames are handled here.
   */
  useEffect(() => {
    if (store === null) return;
    // A reload is two awaits long, and the editor can be gone by the time they
    // resolve. Without this the reply would be written into a disposed store
    // and toasted through a provider that has already unmounted.
    let live = true;

    /*
     * A reload the editor owes but could not perform, because a write was on
     * the wire when the event arrived. Only the version is kept, and only the
     * highest one: several events during one save describe one server, and
     * reloading once from it answers all of them.
     */
    let owed: number | null = null;
    let owedSince: ReturnType<typeof setTimeout> | null = null;

    const forget = () => {
      owed = null;
      if (owedSince !== null) clearTimeout(owedSince);
      owedSince = null;
    };

    const reload = () => {
      void (async () => {
        try {
          // app.js:1109 refreshes the library first, so a slide the agent added
          // resolves its background on the render that follows rather than one
          // request later. Scoped to this slideshow's own account, same as the
          // initial load - the agent that changed it could only have added
          // items from that account (validateComposition, server side).
          await library.refresh(store.getSnapshot().project.accountId);
          // Checked before the read, not after it. A request issued for an
          // editor that has already gone is a request nobody will ever use.
          if (!live) return;
          const { project } = await client.getProject(projectId);
          if (!live) return;
          store.replaceProject(project);
          toast("An agent changed this slideshow, so it reloaded.");
        } catch (error) {
          console.error(error);
          if (!live) return;
          toast("This slideshow changed elsewhere and could not be reloaded.", {
            tone: "danger",
          });
        }
      })();
    };

    /*
     * The other half of the guard. Declining to reload over an unsent edit is
     * right, but dropping the event leaves the reader on a stale document for
     * good, with a healthy stream and nothing to tell them.
     *
     * What is owed is reconsidered rather than replayed. The version is tested
     * against the document again, because the write that just landed may have
     * carried the editor past it: the server broadcasts our own write too, and
     * that broadcast often beats the reply to it, so the commonest deferred
     * event is one the editor no longer needs.
     */
    const stopStore = store.subscribe(() => {
      if (!live || owed === null) return;
      const state = store.getSnapshot();
      if (isOwedWrite(state.saveState)) return;
      const version = owed;
      forget();
      // A 409 has already replaced the document with the server's own copy
      // through Saver.onConflict, so there is nothing left to fetch.
      if (state.saveState === "conflict") return;
      if (version > state.project.version) reload();
    });

    const stop = subscribe((event) => {
      if (!live) return;
      if (event.projectId !== projectId) return;

      if (event.type === "project.status") {
        // app.js:1122-1131 repaints the buttons and calls nothing. The label
        // already holds on the server, so writing it back would be a round trip
        // that says nothing, and routing it through the save would risk the 409
        // the unversioned status endpoint exists to avoid.
        void store.setStatus(event.status, { fromServer: true });
        return;
      }

      if (event.type === "project.removed") {
        // app.js:1140-1142 toasts and opens the dashboard. Staying here would
        // leave the reader editing a document the server no longer has, and
        // every save from that point would fail.
        removed.current = true;
        toast("This slideshow was removed.");
        void navigate("/");
        return;
      }

      const snapshot = store.getSnapshot();
      // app.js:1134. A save of our own comes back as a broadcast, and reloading
      // on it would pull the document out from under the reader mid-edit.
      if (event.version <= snapshot.project.version) return;
      if (isOwedWrite(snapshot.saveState)) {
        /*
         * Deferred, never dropped, and deferred on an edit being *owed* rather
         * than on one being on the wire. The debounce is four hundred
         * milliseconds long and reads as idle for all of it, so a reload
         * arriving in that window used to replace a change the server had never
         * been told about, with nothing to say the reader had lost anything.
         */
        owed = Math.max(owed ?? 0, event.version);
        owedSince ??= setTimeout(() => {
          owedSince = null;
          if (!live || owed === null) return;
          /*
           * Said once, and the reload stays owed. The write may still be coming
           * round: the saver retries a failed write with a backoff that runs
           * for minutes, so a server that comes back brings the edit with it
           * and the deferred reload follows. What must not happen is silence in
           * the meantime, which is the whole of this finding.
           */
          toast(
            "An agent changed this slideshow. Your copy is behind until your edit saves.",
          );
        }, STALE_NOTICE_MS);
        return;
      }
      reload();
    });
    return () => {
      live = false;
      forget();
      stop();
      stopStore();
    };
  }, [client, library, navigate, projectId, store, subscribe, toast]);

  if (load.kind === "loading") {
    return (
      <div className={styles.editor}>
        <Header />
        <p className={styles.state}>Opening this slideshow…</p>
      </div>
    );
  }

  if (load.kind === "failed") {
    return (
      <div className={styles.editor}>
        <Header />
        <p className={`${styles.state ?? ""} ${styles.problem ?? ""}`} role="alert">
          Couldn’t open this slideshow.
        </p>
      </div>
    );
  }

  // Keyed on the project, so opening another slideshow starts with the photo
  // mode off rather than inheriting the last one's.
  return (
    <OpenEditor
      key={projectId}
      store={load.store}
      items={items}
      library={library}
      render={render}
    />
  );
}

type OpenEditorProps = {
  store: EditorStore;
  /** The resolved index the stage reads. */
  items: ReturnType<typeof useLibrary>["items"];
  /** The cache itself, which the rail writes a replaced background back into. */
  library: LibraryCache;
  render?: ThumbnailRenderer | undefined;
};

/*
 * Split out so every hook below reads a store that exists. A conditional
 * useEditor above would have to run before the project has arrived.
 */
function OpenEditor({ store, items, library, render }: OpenEditorProps) {
  const { toast } = useToast();
  // The pixels an agent exports can only be drawn here, so this tab renders
  // them to the server as soon as the slideshow is marked ready.
  usePublishOnReady({
    store,
    library: items,
    onError: (message) => {
      toast(message, { tone: "danger" });
    },
  });
  const { accounts, error: accountsError } = useAccounts();
  const name = useEditor(store, (state) => state.project.name);
  /*
   * The slideshow's own accountId, read straight off the document rather than
   * through ProjectsStore — the editor already has this record loaded, and a
   * second store would be a second place this could disagree with the first.
   * Kept as the whole account, not just its name, because useLayerStack below
   * needs its defaults for a double-click-added text layer.
   */
  const accountId = useEditor(store, (state) => state.project.accountId);
  const account = accounts.find((item) => item.id === accountId) ?? null;
  const accountName = account?.name ?? null;
  /*
   * `account?.defaults ?? BUILTIN_DEFAULTS` below is right while the catalogue
   * is still loading — a cold page must still let a double-click add text. It
   * is silently wrong forever once the fetch has actually failed, since
   * `accounts` then stays `[]` for good and every new text quietly reverts to
   * the built-in look with nothing on screen to say why. Told once, since
   * AccountsStore.refresh() only ever runs the one time here and `error`
   * would otherwise never go away to retrigger this.
   */
  const accountsFailed = useRef(false);
  useEffect(() => {
    if (accountsError === null) return;
    if (accountsFailed.current) return;
    accountsFailed.current = true;
    toast(
      "Couldn’t load this account’s style. New text uses the built-in look for now.",
      {
        tone: "danger",
      },
    );
  }, [accountsError, toast]);
  const activeSlideId = useEditor(store, (state) => state.activeSlideId);
  /*
   * Which slide is being placed, not a plain flag. app.js leaves photo mode
   * both when another slide is chosen (app.js:2179) and when the slide being
   * placed is removed (app.js:3056); deriving it from the active slide covers
   * the pair without an effect that resets state after the fact.
   */
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const photoAdjust = adjusting !== null && adjusting === activeSlideId;
  /*
   * app.js:87-88 held previewVisible and previewChromeChoice. One id carries
   * both, and it lives here rather than in the store because the chrome is a
   * property of this view, not of the document: it is never saved, and two
   * people with the same slideshow open pick their own.
   */
  const [chrome, setChrome] = useState<ChromeId>("none");
  const ratio = useEditor(store, (state) => state.project.ratio);
  const slideIds = useEditor(store, (state) => state.project.slides.map((s) => s.id));
  /*
   * Below 780px the inspector is a sheet over the canvas rather than a column
   * beside it, so something has to say when it is up (app.js:85, app.js:2194).
   *
   * app.js raised it from four places: adding a text (app.js:2975), adding an
   * overlay (app.js:3399), pasting layers (app.js:4722), and entering photo
   * mode (app.js:2201). The first three are the same event seen three times, a
   * layer arriving on the slide, and all three live in another task's files. A
   * layer count is that event without reaching into them. A plain click on a
   * layer deliberately does not raise it, exactly as app.js does not.
   *
   * The count is kept beside the slide it was counted on, so paging the rail
   * onto a busier slide re-baselines rather than reading as growth. Without
   * that pairing, moving from a slide with one layer to one with three raises
   * the sheet over the canvas, and a slide change is not one of app.js's four
   * call sites.
   */
  const [mobileInspector, setMobileInspector] = useState(false);

  /*
   * Adding slides by choosing images (app.js:4128-4192 at c6b3970). The picker
   * has to be opened from inside the click itself, which is why the button's
   * handler does nothing else.
   */
  /*
   * The reload guard. Closing the tab or navigating away inside the debounce
   * window discards an edit the server was never told about, and that window is
   * open for as long as a failed save goes unretried. Browsers ignore any text
   * offered here and show their own wording, so the only decision this makes is
   * whether to raise the prompt at all.
   *
   * It reads the same isOwedWrite the reload deferral does, so the two agree by
   * construction rather than by two conditions that have to be kept in step.
   */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isOwedWrite(store.getSnapshot().saveState)) return;
      event.preventDefault();
      // Firefox still wants the legacy field set before it will prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [store]);

  /*
   * Adding slides. The button opens the picker, and every image that comes back
   * becomes a slide: one chosen from the library, or several just uploaded.
   * The picker owns the upload, so there is nothing to wait for here.
   */
  const [pickingSlides, setPickingSlides] = useState(false);

  const chooseSlides = useCallback(() => {
    setPickingSlides(true);
  }, []);

  const addSlides = useCallback(
    (items: readonly LibraryItem[]) => {
      const result = addSlidesFromItems({ items, store, library });
      if (result.kind !== "added") return;
      toast(`${String(result.count)} ${result.count === 1 ? "slide" : "slides"} added`);
    },
    [library, store, toast],
  );

  const layerCount = useEditor(store, (state) => {
    const slide = activeSlideOf(state);
    return slide === null ? 0 : slide.overlays.length + slide.texts.length;
  });
  const lastCount = useRef({ slideId: activeSlideId, count: layerCount });
  useEffect(() => {
    const previous = lastCount.current;
    const grew = previous.slideId === activeSlideId && layerCount > previous.count;
    lastCount.current = { slideId: activeSlideId, count: layerCount };
    if (grew) setMobileInspector(true);
  }, [activeSlideId, layerCount]);

  useEffect(() => {
    // app.js:1519.
    document.title = `${name} · Slide Studio`;
  }, [name]);

  const actions = useMemo(
    () => (
      <>
        <Button
          variant={photoAdjust ? "solid" : "outline"}
          aria-pressed={photoAdjust}
          onClick={() => {
            // app.js:2199-2202. Placing the photo and holding a layer selected
            // are two different modes, so entering one leaves the other.
            if (!photoAdjust) store.clearSelection();
            setAdjusting(photoAdjust ? null : activeSlideId);
            // app.js:2201 raises the sheet on the way into photo mode, so the
            // zoom is on screen the moment the mode is.
            setMobileInspector(true);
          }}
        >
          <Icon name="adjust" />
          <span>Adjust photo</span>
        </Button>
        <PreviewMenu chrome={chrome} ratio={ratio} onChange={setChrome} />
      </>
    ),
    [activeSlideId, chrome, photoAdjust, ratio, store],
  );

  const remember = useCallback(
    (item: LibraryItem) => {
      library.remember(item);
    },
    [library],
  );

  /*
   * The rail's thumbnails, drawn by the same renderer the export uses
   * (useSlideThumbnail.ts:23 asks for it). Without one the rail shows its
   * placeholder forever. The `render` prop stays ahead of this so a test can
   * still hand in its own.
   */
  const drawThumbnail = useCallback<ThumbnailRenderer>(
    (slide, size) =>
      renderSlideBlob(slide, {
        width: size.width,
        height: size.height,
        assets: items,
      }),
    [items],
  );

  /*
   * Stable across renders as long as the account itself does not change.
   * Both used to be built fresh on every render, so the `useAssetDrop` and
   * `useLayerClipboard` effects below (whose `busy` re-entrancy guard lives
   * on the closure captured when the effect last ran) tore down and
   * re-registered their document listeners on every render during a drag —
   * dropping the guard along with it, so two files dropped together could
   * each start their own upload instead of the second being suppressed.
   * Keyed on `accountId`, which is read reactively above, rather than on
   * `store` itself, so the identity only changes when the account actually
   * does.
   */
  const uploadAsset = useCallback(
    (file: File, name: string) => uploadAssetFile(file, name, accountId),
    [accountId],
  );
  const uploadBackground = useCallback(
    (file: File) => uploadBackgroundItem(file, accountId),
    [accountId],
  );

  /*
   * Task 15's layers, and the crop session they share with the stage. Stage
   * hands the first click on the surface to onFinishCrop rather than clearing
   * the selection, because folding a crop back into an overlay needs the
   * asset's pixel size, which the stage has no reason to hold
   * (app.js:2299-2306).
   */
  const { layers, onFinishCrop } = useLayerStack({
    store,
    library: items,
    defaults: account?.defaults ?? BUILTIN_DEFAULTS,
    photoAdjust,
    // A dropped or pasted asset lands in the project's own account, the same
    // way a replacement background does.
    upload: uploadAsset,
    remember,
    toast,
  });

  return (
    <div className={styles.editor}>
      <Header
        editor
        center={
          <span className={styles.identity ?? ""}>
            <Input
              className={styles.name ?? ""}
              value={name}
              aria-label="Slideshow name"
              maxLength={64}
              onChange={(event) => {
                store.rename(event.target.value);
              }}
            />
            {accountName === null ? null : <Badge>{accountName}</Badge>}
            <SaveIndicator store={store} />
          </span>
        }
      >
        <IconButton
          className={styles.mobileToggle ?? ""}
          icon="edit"
          variant="plain"
          label="Toggle text controls"
          aria-expanded={mobileInspector}
          onClick={() => {
            setMobileInspector((open) => !open);
          }}
        />
        <StatusSwitch store={store} />
        <CaptionPanel store={store} />
        <ExportMenu store={store} library={items} />
        <Button asChild variant="ghost">
          <Link to="/library/backgrounds">
            <Icon name="image" />
            <span>Library</span>
          </Link>
        </Button>
      </Header>
      <main className={styles.shell}>
        <SlideRail
          store={store}
          render={render ?? drawThumbnail}
          library={library}
          onAddSlide={chooseSlides}
        />
        {/*
         * The picker the New slide button opens. It sits here rather than in
         * the rail because adding a slide reaches for the library cache and the
         * toaster, both of which this component already holds.
         */}
        <BackgroundPicker
          open={pickingSlides}
          onOpenChange={setPickingSlides}
          title="New slide"
          description="Choose a background from your library, or upload new images. Each one becomes a slide."
          multiple
          onChoose={addSlides}
          cache={library}
          upload={uploadBackground}
          accountId={accountId}
        />
        {/* Task 15's asset rail, filling the second track of .shell. */}
        <AssetRail store={store} library={items} cache={library} />
        <Stage
          store={store}
          library={items}
          photoAdjust={photoAdjust}
          actions={actions}
          ratioControl={<RatioMenu store={store} library={items} onApplied={toast} />}
          onFinishCrop={onFinishCrop}
        >
          {layers}
          {/*
           * app.js inserted the chrome into the stage element (app.js:963). It
           * rides in with the layers here, after them so it paints over them,
           * and it is decoration only: the export renders from the document.
           */}
          <PreviewChrome
            chrome={chrome}
            ratio={ratio}
            slideCount={slideIds.length}
            slideIndex={Math.max(0, slideIds.indexOf(activeSlideId ?? "")) + 1}
          />
        </Stage>
        <Inspector
          store={store}
          library={items}
          photoAdjust={photoAdjust}
          onFinishCrop={onFinishCrop}
          mobileOpen={mobileInspector}
        />
      </main>
    </div>
  );
}
