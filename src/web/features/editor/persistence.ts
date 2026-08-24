import type { Project } from "@shared/schema/index.js";

/** app.js:1076. */
export const SAVE_DEBOUNCE_MS = 400;

/*
 * Retrying a write that failed. app.js never did: a save that failed and was
 * not followed by another edit sat unsent for ever, so a server restart or a
 * blip left the work stranded unless the person happened to touch that layer
 * again.
 *
 * The wait doubles from a second and stops growing at half a minute, which is
 * slow enough that a server that is simply down is not being hammered, and
 * quick enough that a restart is picked up while the person is still looking at
 * the screen. The ceiling is roughly eight minutes of trying in total.
 */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
export const RETRY_LIMIT = 20;

/**
 * "pending" means a local change exists that the server has not been told
 * about: the debounce is still counting down, or a write failed and nothing is
 * retrying it. Without it there was no way to ask whether an edit was unsent,
 * only whether one was on the wire, and an external write landing inside the
 * debounce window overwrote the edit with nothing to say it had.
 */
export type SaveState = "idle" | "pending" | "saving" | "conflict";

/**
 * Task 11's PUT, narrowed to what the store needs. It takes the live project
 * and answers with the server's copy, whose version and updatedAt the store
 * then adopts (app.js:340-348).
 */
export type SaveFn = (project: Project) => Promise<Project>;

/**
 * What a stale write throws. The server answers a version mismatch with a 409
 * carrying its own current copy (src/server/services/projects.ts:120-124), so
 * the editor can reload straight from the error instead of issuing the second
 * GET that app.js:1108-1117 does.
 */
export type ConflictError = Error & {
  status: 409;
  project?: Project | undefined;
};

export function isConflictError(error: unknown): error is ConflictError {
  if (typeof error !== "object" || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

/**
 * The server's copy out of a 409, or null when the error carries nothing
 * usable. A 409 with no project is still a conflict, but the editor cannot
 * reload from it and must report the failure instead of guessing.
 */
export function conflictProject(error: unknown): Project | null {
  if (!isConflictError(error)) return null;
  const project = error.project;
  if (!project || typeof project !== "object") return null;
  return Array.isArray(project.slides) ? project : null;
}

export type SaverDeps = {
  save: SaveFn;
  /** The live project, read afresh on every attempt, the way app.js:1105 re-reads activeProject(). */
  project: () => Project;
  now?: (() => number) | undefined;
  onSaved?: ((saved: Project) => void) | undefined;
  onConflict?: ((server: Project) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onStateChange?: ((state: SaveState) => void) | undefined;
};

/**
 * The debounced, version-guarded writer, ported from app.js:1070-1117.
 *
 * One save is in flight at a time. Everything that lands while one is running
 * is coalesced into a single follow-up, so a fast edit stream cannot open a
 * queue of racing writes.
 */
export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Reset by a successful save and by any new edit, so a slideshow being worked
  // on never runs out of attempts partway through an afternoon.
  private attempts = 0;
  // Latched by settle, which only dispose calls. Without it an editor that has
  // been closed keeps retrying against the server for another eight minutes.
  private closed = false;
  private running: Promise<void> | null = null;
  private queued = false;
  private state: SaveState = "idle";

  constructor(private readonly deps: SaverDeps) {}

  getState(): SaveState {
    return this.state;
  }

  /**
   * Resolves once nothing is left to write.
   *
   * A pending debounce is written. A write already in flight is only waited
   * on, never followed by another: flush() would set the queued flag and cost
   * a second round trip that has nothing new to say.
   */
  settle(): Promise<void> {
    const owed = this.timer !== null || this.retryTimer !== null;
    // Latched before the flush, so the attempt below is the last one and a
    // failure does not arm another against an editor that has gone.
    this.closed = true;
    if (owed) return this.flush();
    return this.running ?? Promise.resolve();
  }

  /** app.js:1070-1077. Stamps updatedAt, then restarts the debounce. */
  schedule(): void {
    this.deps.project().updatedAt = (this.deps.now ?? Date.now)();
    this.cancel();
    // A fresh edit is a fresh start: whatever went wrong before, this is a new
    // write and it deserves the full run of attempts.
    this.attempts = 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    // From this moment the document differs from the server's copy.
    this.setState("pending");
  }

  /**
   * Drops a pending debounce without saving. Only schedule() and flush() use
   * this, both of which are about to write anyway. Dropping a pending edit on
   * the way out would lose it, so a teardown flushes rather than cancels.
   */
  cancel(): void {
    // Both, because the only callers are schedule and flush and each is about
    // to write anyway. Leaving an armed retry behind would send that write
    // twice, once now and once when the retry came round.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Saves now, and resolves once nothing is left to write. app.js leaves the
   * pending debounce running through a manual flush, which then writes a second
   * time for no reason; dropping it here costs nothing and saves a round trip.
   */
  flush(): Promise<void> {
    this.cancel();
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // The field has to be set before run() touches it, so that a save started
    // from inside a listener queues instead of racing.
    this.running = done;
    void this.run()
      .catch((error: unknown) => {
        this.deps.onError?.(error);
      })
      .finally(() => {
        this.running = null;
        settle();
      });
    return done;
  }

  private async run(): Promise<void> {
    for (;;) {
      this.setState("saving");
      try {
        const saved = await this.deps.save(this.deps.project());
        // A save that answers with nothing usable leaves the local version
        // where it is rather than throwing inside the caller's listener.
        if (saved && typeof saved === "object") this.deps.onSaved?.(saved);
        this.attempts = 0;
        this.setState("idle");
      } catch (error) {
        if (isConflictError(error)) {
          const server = conflictProject(error);
          if (server) {
            // onConflict runs inside this catch, and the reload it performs
            // parses the payload, which can throw on a 409 body that got past
            // conflictProject. Letting that escape would skip the setState
            // below and leave the editor reporting "saving" forever while it
            // holds a document the server has already replaced.
            try {
              this.deps.onConflict?.(server);
            } catch (reloadError) {
              this.deps.onError?.(reloadError);
            }
          } else {
            this.deps.onError?.(error);
          }
          // The write lost either way, so the state says so even when the
          // reload could not be performed. Reporting "idle" would claim the
          // save succeeded.
          this.setState("conflict");
        } else {
          /*
           * Reported once per run of attempts, not once per attempt. app.js
           * toasted every failure, which with retries would put twenty of the
           * same message on screen; the indicator carries the ongoing state and
           * this says it out loud the first time.
           */
          if (this.attempts === 0) this.deps.onError?.(error);
          // Still unsent, so the state says the change is owed rather than
          // claiming the document is clean.
          this.setState("pending");
          this.armRetry();
        }
      }
      if (!this.queued) return;
      this.queued = false;
    }
  }

  /*
   * Arms the next attempt. A conflict never gets here: the server's copy has
   * already replaced the document, so there is nothing left to send, and a
   * retry would be an argument the editor has already lost.
   *
   * A stale retry cannot clobber either way. The write carries the version it
   * was built from, so one that has been overtaken takes the 409 and reloads
   * through onConflict, exactly as any other losing write does.
   */
  private armRetry(): void {
    if (this.closed) return;
    if (this.attempts >= RETRY_LIMIT) return;
    const wait = Math.min(RETRY_BASE_MS * 2 ** this.attempts, RETRY_MAX_MS);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, wait);
  }

  private setState(next: SaveState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onStateChange?.(next);
  }
}
