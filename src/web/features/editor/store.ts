import { useCallback, useSyncExternalStore } from "react";
import { parseProject } from "@shared/schema/index.js";
import type {
  Project,
  Slide,
  SlideDocument,
  SlideshowStatus,
} from "@shared/schema/index.js";
import { History, HISTORY_LIMIT, restoreDocument, snapshotDocument } from "./history.js";
import type { DocumentSnapshot } from "./history.js";
import { Saver } from "./persistence.js";
import type { SaveFn, SaveState } from "./persistence.js";
import {
  isLayerSelected,
  layerKey,
  moveLayer as moveLayerOnSlide,
  selectOnlyLayer,
  setLayerSelection,
  toggleLayerSelection,
} from "./selection.js";
import type { LayerKey, LayerKind, LayerMove } from "./selection.js";

export type EditorState = {
  project: Project;
  activeSlideId: string | null;
  selection: LayerKey[];
  primary: LayerKey | null;
  croppingOverlayId: string | null;
  saveState: SaveState;
};

/**
 * The status endpoint, which is not the save endpoint.
 *
 * Status is a label on the slideshow rather than part of its document, so the
 * server writes it without the version guard and without touching the version
 * (src/server/services/projects.ts:69-84): marking something ready must never
 * make an open editor's next save conflict. app.js:946 calls it on its own,
 * outside scheduleSave, for that reason.
 */
export type SetStatusFn = (
  projectId: string,
  status: SlideshowStatus,
) => Promise<unknown>;

export type EditorDeps = {
  save: SaveFn;
  setStatus?: SetStatusFn | undefined;
  now?: (() => number) | undefined;
  /** app.js:1096-1097 logs and toasts a failed save. Task 14 decides how to show it. */
  onError?: ((error: unknown) => void) | undefined;
};

export type SetStatusOptions = {
  /**
   * The server already holds this status, so adopt it without writing it back.
   * The status arrives this way over the event stream, which handleServerEvent
   * adopts at app.js:1128-1133 without calling the API.
   */
  fromServer?: boolean;
};

export type MutateOptions = {
  history?: boolean;
  save?: boolean;
};

function sameKeys(a: readonly LayerKey[], b: readonly LayerKey[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** The slide a state points at, for a selector that needs the slide itself. */
export function activeSlideOf(state: EditorState): Slide | null {
  return state.project.slides.find((slide) => slide.id === state.activeSlideId) ?? null;
}

/**
 * Everything the editor holds for one open slideshow: the document, the undo
 * stacks, the layer selection, and the debounced writer.
 *
 * The document is mutated in place, the way app.js has always mutated it, and
 * only the snapshot handed to React is replaced on every change. That keeps a
 * sixty-frame drag from cloning the document sixty times.
 */
export class EditorStore {
  private project: Project;
  private activeSlideId: string | null;
  private selection: LayerKey[] = [];
  private primary: LayerKey | null = null;
  private croppingOverlayId: string | null = null;
  private saveState: SaveState = "idle";
  private snapshot: EditorState;
  private readonly listeners = new Set<() => void>();
  private readonly history = new History<DocumentSnapshot>(HISTORY_LIMIT);
  private readonly saver: Saver;
  // app.js:108. A snapshot taken while an undo is being applied would record
  // the undo itself, so nothing records under this flag.
  private applying = false;
  private transactionDepth = 0;
  // Set by dispose. Every writer checks it, so a stray handler firing after
  // teardown cannot re-arm the saver and put a write on the wire.
  private disposed = false;
  // Held so a second close waits on the same write the first one did, rather
  // than resolving early and telling its caller the editor is safely shut.
  private closing: Promise<void> | null = null;

  constructor(
    project: Project,
    private readonly deps: EditorDeps,
  ) {
    this.project = project;
    this.activeSlideId = project.slides[0]?.id ?? null;
    this.saver = new Saver({
      save: deps.save,
      project: () => this.project,
      now: deps.now,
      onSaved: (saved) => this.adoptSaved(saved),
      onConflict: (server) => this.replaceProject(server),
      onError: deps.onError,
      onStateChange: (state) => {
        this.saveState = state;
        this.publish();
      },
    });
    this.snapshot = this.build();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): EditorState {
    return this.snapshot;
  }

  /**
   * Mutates the document and records one undo entry. Pass `history: false` for
   * a step that belongs to an entry someone else already recorded, and
   * `save: false` for a change the caller will save itself.
   */
  mutate(recipe: (document: SlideDocument) => void, options?: MutateOptions): void {
    if (this.disposed) return;
    if (options?.history !== false) this.record();
    recipe(this.project);
    this.reconcile();
    if (options?.save !== false) this.saver.schedule();
    this.publish();
  }

  /**
   * Coalesces every mutate inside into one undo entry.
   *
   * A drag is the reason this exists: app.js records at pointer-down
   * (app.js:3977) and then mutates freely on every pointermove, so the whole
   * drag undoes in one step. Like that pointer-down, an entry is recorded even
   * when the body ends up changing nothing.
   */
  transaction(run: () => void): void {
    if (this.transactionDepth > 0) {
      run();
      return;
    }
    this.record();
    this.transactionDepth = 1;
    try {
      run();
    } finally {
      this.transactionDepth = 0;
    }
  }

  undo(): void {
    if (this.disposed) return;
    if (!this.history.canUndo()) return;
    const snapshot = this.history.undo(snapshotDocument(this.project));
    if (snapshot) this.apply(snapshot);
  }

  redo(): void {
    if (this.disposed) return;
    if (!this.history.canRedo()) return;
    const snapshot = this.history.redo(snapshotDocument(this.project));
    if (snapshot) this.apply(snapshot);
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  /** app.js:2177-2179. A selection belongs to the slide it was made on. */
  setActiveSlide(id: string): void {
    if (this.activeSlideId === id) return;
    if (!this.project.slides.some((slide) => slide.id === id)) return;
    this.activeSlideId = id;
    this.selection = [];
    this.primary = null;
    this.croppingOverlayId = null;
    this.publish();
  }

  select(keys: readonly LayerKey[], primary?: LayerKey | null): void {
    this.applySelection(
      setLayerSelection(
        this.activeSlide(),
        keys,
        primary === undefined ? (keys.at(-1) ?? null) : primary,
      ),
    );
  }

  /** app.js:414-417, the single click on a layer. */
  selectOnly(kind: LayerKind, id: string): void {
    this.applySelection(selectOnlyLayer(this.activeSlide(), kind, id));
  }

  /** app.js:419-424, the shift click. */
  toggleSelect(kind: LayerKind, id: string): void {
    this.applySelection(
      toggleLayerSelection(this.activeSlide(), this.selection, kind, id),
    );
  }

  /**
   * app.js:565-568 also leaves crop mode, which folds the crop back into the
   * overlay's geometry. That needs the asset's real pixel size, which this
   * layer has no way to reach, so a caller in crop mode must apply the
   * geometry through mutate before calling this.
   */
  clearSelection(): void {
    this.croppingOverlayId = null;
    this.applySelection({ keys: [], primary: null });
  }

  setCropping(overlayId: string | null): void {
    if (this.croppingOverlayId === overlayId) return;
    this.croppingOverlayId = overlayId;
    this.publish();
  }

  /**
   * app.js:2159-2163. A rename rides the same version-guarded PUT the document
   * does, so it only schedules a save. It records no undo entry, because
   * app.js never recorded one and a history entry holds the document alone, so
   * an entry here could never undo the rename anyway.
   */
  rename(name: string): void {
    if (this.disposed) return;
    const next = name || "New Project";
    if (this.project.name === next) return;
    this.project.name = next;
    this.saver.schedule();
    this.publish();
  }

  /**
   * The caption the slideshow is posted with, and the tags under it.
   *
   * Written straight onto the project and saved by the debounce, the way a
   * rename is. Going through mutate would be wrong twice over: the undo stacks
   * hold the document alone (snapshotDocument), so an entry recorded here could
   * restore no caption and would undo the reader's last slide edit instead.
   * What matters is the saver. schedule() is what makes an edit count as
   * unsaved, defer an incoming reload, and raise the unload prompt, and a write
   * that skipped it would lose the caption with nothing on screen to say so.
   */
  setDescription(description: string): void {
    this.writeCaption("description", description);
  }

  setHashtags(hashtags: string): void {
    this.writeCaption("hashtags", hashtags);
  }

  private writeCaption(field: "description" | "hashtags", value: string): void {
    if (this.disposed) return;
    if (this.project[field] === value) return;
    this.project[field] = value;
    this.saver.schedule();
    this.publish();
  }

  /**
   * app.js:937-951. Writes the label straight away, then tells the server, and
   * puts the old one back if the server refuses.
   *
   * This deliberately does not go through mutate. Status is not in the
   * document, it does not travel on the save, it takes no undo entry, and the
   * server writes it without the version guard, so routing it through the
   * debounced save would both lose it and risk a conflict it is designed to
   * avoid. Resolves once the server has answered; rejects never, so a caller
   * that does not care can ignore the promise.
   */
  async setStatus(status: SlideshowStatus, options?: SetStatusOptions): Promise<void> {
    if (this.disposed) return;
    const previous = this.project.status;
    if (previous === status) return;
    this.project.status = status;
    this.publish();
    // An agent's change reaches an open editor through the event stream. The
    // server already holds it, so writing it back would be a round trip that
    // says nothing, and a rollback on failure would fight the server.
    if (options?.fromServer) return;
    if (!this.deps.setStatus) return;
    try {
      await this.deps.setStatus(this.project.id, status);
    } catch (error) {
      this.project.status = previous;
      this.publish();
      this.deps.onError?.(error);
    }
  }

  /** app.js:582-627, wrapped in the one undo entry and the save that call makes. */
  moveLayer(kind: LayerKind, id: string, action: LayerMove): void {
    const selection = isLayerSelected(this.selection, kind, id)
      ? this.selection
      : [layerKey(kind, id)];
    this.mutate(() => {
      moveLayerOnSlide(this.activeSlide(), kind, id, action, selection);
    });
  }

  /**
   * Adopts the server's copy after a 409.
   *
   * The undo stacks go with it. app.js does not clear them here (only opening a
   * project does, at app.js:2076-2077), which leaves entries describing a
   * document the server has since replaced: one undo would then write the
   * agent's change straight back out. Clearing is the point of reloading rather
   * than clobbering, and it is what the brief's test asks for.
   *
   * The payload is repaired on the way in. app.js:1109 runs normalizeProject
   * over the reloaded project, so skipping it here would let a conflict reload
   * install a document that never got its defaults or its z back-fill, which
   * every other entry point into the editor does get.
   */
  replaceProject(project: Project): void {
    this.project = parseProject(project);
    this.history.clear();
    this.croppingOverlayId = null;
    if (!this.project.slides.some((slide) => slide.id === this.activeSlideId)) {
      this.activeSlideId = this.project.slides[0]?.id ?? null;
    }
    const next = setLayerSelection(this.activeSlide(), this.selection, this.primary);
    this.selection = next.keys;
    this.primary = next.primary;
    this.publish();
  }

  /** Saves now, and resolves once nothing is left to write. */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.saver.flush();
  }

  /**
   * Writes anything still pending, then stops listening.
   *
   * app.js keeps its save timer in a module global that outlives the editor
   * view, so an edit made a moment before navigating away still reaches the
   * server. Cancelling here instead would lose it, quietly. Resolves once
   * nothing is left to write, and does nothing at all when the saver is
   * already idle, so closing an untouched editor writes nothing.
   *
   * Latches. Every writer on this class is inert afterwards, so a handler that
   * fires after teardown cannot re-arm the saver and put a write on the wire.
   */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.listeners.clear();
    this.closing = this.saver.settle();
    return this.closing;
  }

  private activeSlide(): Slide | null {
    return this.project.slides.find((slide) => slide.id === this.activeSlideId) ?? null;
  }

  private applySelection(next: { keys: LayerKey[]; primary: LayerKey | null }): void {
    this.selection = next.keys;
    this.primary = next.primary;
    this.publish();
  }

  private record(): void {
    if (this.applying) return;
    if (this.transactionDepth > 0) return;
    this.history.record(snapshotDocument(this.project));
  }

  private apply(snapshot: DocumentSnapshot): void {
    this.applying = true;
    try {
      restoreDocument(this.project, snapshot);
      this.reconcile();
      // app.js:168.
      this.croppingOverlayId = null;
      this.publish();
      // app.js:169 writes the restored document at once rather than debouncing.
      void this.saver.flush();
    } finally {
      this.applying = false;
    }
  }

  /**
   * app.js:165-167. A slide or a layer the state pointed at may have gone, so
   * the pointers move somewhere real rather than dangling.
   */
  private reconcile(): void {
    if (
      this.activeSlideId !== null &&
      !this.project.slides.some((slide) => slide.id === this.activeSlideId)
    ) {
      this.activeSlideId = this.project.slides[0]?.id ?? null;
    }
    const next = setLayerSelection(this.activeSlide(), this.selection, this.primary);
    if (!sameKeys(next.keys, this.selection)) this.selection = next.keys;
    this.primary = next.primary;
    // Crop mode points at one overlay, so it dangles for the same reason a
    // selection key does. An editor left cropping an overlay that is no longer
    // there has no way back out.
    if (
      this.croppingOverlayId !== null &&
      !(this.activeSlide()?.overlays ?? []).some(
        (overlay) => overlay.id === this.croppingOverlayId,
      )
    ) {
      this.croppingOverlayId = null;
    }
  }

  private adoptSaved(saved: Project): void {
    // app.js:341-346 takes back these two fields only, so a rename made while
    // the write was in flight is not rolled back by the reply.
    this.project.version = saved.version;
    this.project.updatedAt = saved.updatedAt;
    this.publish();
  }

  private build(): EditorState {
    return Object.freeze({
      project: this.project,
      activeSlideId: this.activeSlideId,
      selection: this.selection,
      primary: this.primary,
      croppingOverlayId: this.croppingOverlayId,
      saveState: this.saveState,
    });
  }

  private publish(): void {
    this.snapshot = this.build();
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Reads a slice of the store.
 *
 * The selector runs on the state React handed back rather than inside
 * getSnapshot, because a selector returning a fresh array or object every call
 * would make useSyncExternalStore see an endlessly changing snapshot. The store
 * replaces its snapshot on every edit anyway, which is the same granularity the
 * old app rendered at.
 */
export function useEditor<T>(store: EditorStore, selector: (state: EditorState) => T): T {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  return selector(useSyncExternalStore(subscribe, getSnapshot, getSnapshot));
}
