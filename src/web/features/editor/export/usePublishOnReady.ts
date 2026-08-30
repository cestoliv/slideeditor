import { useEffect, useRef } from "react";
import type { Project } from "@shared/schema/index.js";
import { api } from "../../../app/api.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { useEditor } from "../store.js";
import type { EditorStore } from "../store.js";
import { publishRenders } from "./publish.js";

export type PublishDeps = {
  publish: typeof publishRenders;
  upload: (
    id: string,
    index: number,
    input: { version: number; data: string },
  ) => Promise<unknown>;
};

const REAL: PublishDeps = {
  publish: publishRenders,
  upload: (id, index, input) => api.putProjectRender(id, index, input),
};

/**
 * Every image the render needs is in hand.
 *
 * The library arrives after this effect first runs: useLibrary's fetch lives in
 * the parent (Editor.tsx:129, useLibrary.ts:244) and a child's effects run
 * first, so a cold open of a ready slideshow commits once with an empty map.
 * renderSlideCanvas skips an asset it cannot resolve (render.ts:284, :391)
 * instead of failing, so publishing then would upload text on blank
 * backgrounds and the version guard would keep it that way.
 */
function assetsResolved(project: Project, library: LibraryIndex): boolean {
  return project.slides.every(
    (slide) =>
      library.has(slide.backgroundItemId) &&
      slide.overlays.every((overlay) => library.has(overlay.itemId)),
  );
}

export type PublishOnReadyInput = {
  store: EditorStore;
  /** The resolved library the render draws backgrounds and overlays from. */
  library: LibraryIndex;
  onError?: ((message: string) => void) | undefined;
  /** Injected by the tests. Production passes nothing. */
  deps?: Partial<PublishDeps> | undefined;
};

/**
 * Renders a slideshow to the server the moment it is ready.
 *
 * The pixels only exist in a browser (render.ts draws on a canvas and measures
 * with document.fonts), so this tab is the only thing that can give an agent
 * something to hand a scheduling tool. Marking a slideshow ready is the point
 * where a human says the composition is final, which makes it the honest moment
 * to freeze it.
 *
 * It covers the agent path too, without a new event: ProjectService.setStatus
 * broadcasts project.status, and Editor.tsx applies that event to this store, so
 * an agent calling set_slideshow_status makes an open tab publish.
 *
 * Two tabs both publish, which is harmless. The media store is content
 * addressed and the render table's primary key makes the write idempotent.
 */
export function usePublishOnReady({
  store,
  library,
  onError,
  deps,
}: PublishOnReadyInput): void {
  const status = useEditor(store, (state) => state.project.status);
  const id = useEditor(store, (state) => state.project.id);
  const version = useEditor(store, (state) => state.project.version);
  // What has been published from this tab. Keyed on the version, so an edit
  // made while ready republishes and a re-render does not.
  const published = useRef<string | null>(null);
  // Read fresh inside the effect rather than closed over. Editor.tsx hands
  // onError a new arrow on every render of OpenEditor, and deps is a fresh
  // object literal wherever it is passed, so exhaustive-deps would put two
  // values in the array that change identity on every render. The effect would
  // then tear down and rebuild on every mouse move, for a run that reads the
  // key guard and returns.
  // Written in their own effects, not during render: react-hooks/refs forbids
  // a ref write in the render body, and effects declared above the one below
  // still commit before it does, so the value is current by the time it reads.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);
  // Whether this tab still has the editor open. Scoped to the mount rather than
  // to one effect run, because a run being superseded is not a reason to drop
  // its failure: the library changing mid-publish re-runs the effect, and the
  // re-run returns at the key guard, so the first pass is the only one that can
  // report. Only an unmount makes the toast pointless.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    const key = `${id}:${String(version)}`;
    if (published.current === key) return;
    const project = store.getSnapshot().project;
    // Wait for a library that can actually draw every slide, so a cold open
    // of a ready slideshow doesn't publish blank backgrounds and have the
    // key guard above lock that in for good.
    if (!assetsResolved(project, library)) return;
    // Claimed before the first await, so a second effect run cannot start a
    // duplicate pass while this one is still rendering.
    published.current = key;

    const publish = depsRef.current?.publish ?? REAL.publish;
    const upload = depsRef.current?.upload ?? REAL.upload;

    void (async () => {
      try {
        await publish({
          project,
          library,
          upload: (index, data) => upload(id, index, { version, data }),
        });
      } catch (error) {
        if (!alive.current) return;
        // Cleared, so leaving and returning to the slideshow retries rather
        // than leaving it permanently unexportable in this tab.
        published.current = null;
        console.error(error);
        onErrorRef.current?.(
          "This slideshow couldn’t be prepared for agents. Reopen it to try again.",
        );
      }
    })();
  }, [id, library, status, store, version]);
}
