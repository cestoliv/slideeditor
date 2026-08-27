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
  // True from the moment a run() cycle starts until the exact synchronous
  // instant it commits to returning (see run()'s loop) — never later, in a
  // .finally() callback. flush()'s decision to piggyback a queued follow-up
  // onto the current cycle, versus start a fresh one, reads this rather than
  // `running`'s truthiness, because `running` stays non-null for a few
  // microtask ticks after the cycle has already decided not to loop again
  // (see run()'s doc comment for the race this closes).
  private looping = false;
  // Identifies which flush()-started cycle a given `.finally()` belongs to,
  // so a stale one (attached to a cycle that already exited) cannot null out
  // `running` out from under a newer cycle that started in the gap between
  // the old cycle returning and its `.finally()` actually running.
  private runId = 0;
  private queued = false;
  private state: SaveState = "idle";

  constructor(private readonly deps: SaverDeps) {}

  getState(): SaveState {
    return this.state;
  }

  /**
   * Resolves once nothing is left to write.
   *
   * A pending debounce is written, and so is an edit whose last attempt was
   * rejected and is only waiting out a backoff: an armed `retryTimer` means
   * that write has not reached the server, and dropping it on the way out
   * would lose it exactly the way a pending debounce would. Losing an edit is
   * far worse than the extra round trip of sending it once more.
   *
   * A write already genuinely in flight — `looping` is true, meaning a run()
   * cycle has not yet committed to stopping — is only waited on, via
   * `flush()`'s piggyback branch, never followed by a second, redundant send:
   * that is what keeps this idempotent rather than piling a second identical
   * send on top of one already on the wire (which is what put "Half typed"
   * through client.save twice, nondeterministically, depending on whether the
   * debounce or the unmount landed first).
   *
   * `looping`, not `running`'s truthiness, is what `flush()` reads to make
   * that call. `running` stays non-null for a few microtask ticks after a
   * cycle has already decided (synchronously, inside run()'s own loop) not to
   * continue — armRetry() can set retryTimer inside that same synchronous
   * span, so a settle() landing in that gap used to see `owed = true`, call
   * flush(), find `running` still set, and just queue a follow-up nothing was
   * left to service — losing the edit outright, with no error and no future
   * retry. `looping` closes that gap: it flips to false in the same
   * synchronous step run() decides to stop, so a settle() landing anywhere
   * after that point sees `looping === false` and starts a fresh cycle
   * (resending the edit) instead of queuing onto one that will never check
   * `queued` again.
   *
   * `owed` is read only AFTER waiting for anything already in flight, and
   * `closed` is set only after that — not both up front, the way this used
   * to work. A save that is still running when settle() is called has not
   * failed yet, so nothing is owed *yet* either; reading `owed` first, and
   * latching `closed` before the wait, meant a failure that happened during
   * that very wait found `closed` already true and armRetry() refused to
   * arm a retry for it, leaving settle() waiting on an attempt whose failure
   * it would then have no way to notice — the edit vanished with no error
   * and nothing to resend it. Checking again once the wait is over is what
   * catches that: the retry a same-attempt failure just armed is exactly
   * what the flush below sends, bypassing its backoff instead of waiting it
   * out on the way out. `closed` still comes before that flush, so a
   * failure of this last, explicit attempt does not arm yet another.
   */
  async settle(): Promise<void> {
    if (this.looping) await (this.running ?? Promise.resolve());
    const owed = this.timer !== null || this.retryTimer !== null;
    this.closed = true;
    if (owed) await this.flush();
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
    // `looping`, not `running`'s truthiness — see settle()'s doc comment for
    // the race that distinction closes.
    if (this.looping) {
      this.queued = true;
      return this.running ?? Promise.resolve();
    }
    const id = (this.runId += 1);
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Both set before run() touches anything, so a save started from inside
    // a listener queues instead of racing.
    this.running = done;
    this.looping = true;
    void this.run()
      .catch((error: unknown) => {
        this.deps.onError?.(error);
      })
      .finally(() => {
        // Only this cycle's own `.finally()` may clear `running`: one that
        // belongs to a cycle flush() has already superseded (its `runId` no
        // longer matches) must not stomp the newer cycle's own bookkeeping
        // just because it happens to fire after the newer one already
        // started.
        if (this.runId === id) this.running = null;
        settle();
      });
    return done;
  }

  /**
   * `looping` stays true for the whole of this method's execution, across
   * every attempt a queued follow-up causes it to loop back for, and flips
   * to false the instant this method actually exits — return or throw —
   * via the `finally` wrapping the loop below, not on the one path that used
   * to set it directly. `deps.onStateChange` (called from `setState`) and
   * `deps.onError` are both caller-supplied listeners this method does not
   * control, and either can throw: a throw out of `setState("saving")`,
   * which runs before the inner try, used to skip the `looping = false`
   * that only sat after the loop's own try/catch, leaving `looping` stuck
   * true forever — every future `flush()` call would see it set, queue onto
   * a `running` promise that had already resolved, and return having saved
   * nothing. The outer `finally` runs synchronously as part of unwinding
   * the throw (or the `return` below), so it costs nothing new: it fires at
   * the exact same synchronous instant the old direct assignment did, just
   * on every exit path instead of only the one that reached it.
   *
   * That synchronous timing is still what makes `settle()` safe. armRetry()
   * can arm `retryTimer` from inside the catch block just above the `return`
   * below, in the very same synchronous span, so there is no gap in which
   * `retryTimer` is armed but `looping` still reads true: a settle() that
   * lands after this method has decided to stop (by returning, or now by
   * throwing) always sees `looping === false` and starts a fresh cycle
   * rather than queuing onto one that will never check `queued` again.
   */
  private async run(): Promise<void> {
    try {
      for (;;) {
        this.setState("saving");
        // Only the network attempt and its own failure handling live inside
        // this try. A listener throwing on the SUCCESS path (onSaved, or
        // onStateChange("idle")) must not land in this catch: that used to
        // make a save that actually reached the server get reported as
        // failed, and resent.
        let outcome: { ok: true; saved: Project } | { ok: false };
        try {
          const saved = await this.deps.save(this.deps.project());
          outcome = { ok: true, saved };
        } catch (error) {
          outcome = { ok: false };
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
        if (outcome.ok) {
          this.attempts = 0;
          // A save that answers with nothing usable leaves the local version
          // where it is rather than throwing inside the caller's listener. A
          // throw from onSaved itself is reported, not mistaken for the save
          // having failed — the write already succeeded.
          try {
            if (outcome.saved && typeof outcome.saved === "object") {
              this.deps.onSaved?.(outcome.saved);
            }
          } catch (error) {
            this.deps.onError?.(error);
          }
          this.setState("idle");
        }
        if (!this.queued) return;
        this.queued = false;
      }
    } finally {
      this.looping = false;
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
    // A queued follow-up loops straight back through run() without going
    // through cancel() (only schedule() and flush() call that), so a prior
    // attempt's retry can still be armed here. Overwriting `retryTimer`
    // without clearing it first would leak that timer: it would go on to
    // fire on its own schedule, flush a stale document, and — the one
    // reference to the *new* timer having just been stomped — leave that
    // new timer's own eventual flush unreachable by cancel(), so neither
    // schedule() nor settle() could stop it from also firing later.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
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
    // onStateChange is a caller-supplied listener (EditorStore wires it to
    // publish(), which calls every subscriber synchronously) and this method
    // does not control what it does. The state is already committed above,
    // so a throw here reports the listener's failure rather than aborting
    // whatever this setState call was a step of — a throw on the "saving"
    // transition used to escape before deps.save() was ever called, losing
    // the edit and stranding the indicator on "saving" forever.
    try {
      this.deps.onStateChange?.(next);
    } catch (error) {
      this.deps.onError?.(error);
    }
  }
}
