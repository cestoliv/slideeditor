import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/schema/index.js";
import {
  conflictProject,
  isConflictError,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SAVE_DEBOUNCE_MS,
  Saver,
} from "./persistence.js";
import type { ConflictError, SaveState } from "./persistence.js";
import { fixtureProject } from "./testing.js";

function conflictError(project?: Project): ConflictError {
  return Object.assign(new Error("This slideshow changed since you loaded it."), {
    status: 409 as const,
    project,
  });
}

/** A saver over one live project, with every callback recorded. */
function harness(save: (project: Project) => Promise<Project>, now = () => 1_000) {
  const project = fixtureProject();
  const saved: Project[] = [];
  const conflicts: Project[] = [];
  const errors: unknown[] = [];
  const states: SaveState[] = [];
  const saver = new Saver({
    save,
    project: () => project,
    now,
    onSaved: (reply) => saved.push(reply),
    onConflict: (server) => conflicts.push(server),
    onError: (error) => errors.push(error),
    onStateChange: (state) => states.push(state),
  });
  return { project, saver, saved, conflicts, errors, states };
}

/** The server's reply: the same project, one version on. */
function reply(project: Project, updatedAt = 2_000): Project {
  return { ...structuredClone(project), version: project.version + 1, updatedAt };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recognising a conflict", () => {
  it("reads a 409 as a conflict", () => {
    expect(isConflictError(conflictError(fixtureProject()))).toBe(true);
  });

  it("reads anything else as a plain failure", () => {
    expect(isConflictError(new Error("offline"))).toBe(false);
    expect(isConflictError(Object.assign(new Error("gone"), { status: 404 }))).toBe(
      false,
    );
    expect(isConflictError(null)).toBe(false);
    expect(isConflictError("409")).toBe(false);
  });

  it("takes the server's copy out of the error", () => {
    const server = fixtureProject({ version: 7 });
    expect(conflictProject(conflictError(server))?.version).toBe(7);
  });

  it("answers null for a 409 carrying nothing it can reload from", () => {
    expect(conflictProject(conflictError())).toBeNull();
    expect(
      conflictProject(Object.assign(new Error("stale"), { status: 409, project: 12 })),
    ).toBeNull();
  });
});

describe("the debounce", () => {
  it("coalesces a burst of edits into one save", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver } = harness(save);
    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledOnce();
  });

  it("restarts the wait on every edit, so a steady stream never writes mid-drag", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver } = harness(save);
    for (let step = 0; step < 5; step += 1) {
      saver.schedule();
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledOnce();
  });

  it("sends the live project, with the version it is holding now", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { project, saver } = harness(save);
    project.version = 12;
    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save.mock.calls[0]?.[0].version).toBe(12);
  });

  it("stamps updatedAt from the clock it was given", () => {
    const { project, saver } = harness(
      async (value: Project) => reply(value),
      () => 555,
    );
    saver.schedule();
    expect(project.updatedAt).toBe(555);
  });

  it("drops a pending save on cancel", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver } = harness(save);
    saver.schedule();
    saver.cancel();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("one write at a time", () => {
  it("queues one more save when an edit lands mid-flight, and no more", async () => {
    // A box, so the reference the save writes is not narrowed away by control flow.
    const gate: { release: () => void } = { release: () => {} };
    const save = vi.fn(async (project: Project) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return reply(project);
    });
    const { saver } = harness(save);

    const first = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();

    // Three edits land while the first write is still open.
    void saver.flush();
    void saver.flush();
    void saver.flush();
    expect(save).toHaveBeenCalledOnce();

    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);

    gate.release();
    await first;
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("resolves the caller only once the follow-up has been written too", async () => {
    const order: string[] = [];
    let opened = 0;
    const save = vi.fn(async (project: Project) => {
      opened += 1;
      const mine = opened;
      await Promise.resolve();
      order.push(`save ${mine}`);
      return reply(project);
    });
    const { saver } = harness(save);
    const first = saver.flush();
    void saver.flush();
    await first;
    order.push("resolved");
    expect(order).toEqual(["save 1", "save 2", "resolved"]);
  });

  // The second caller must get a promise that outlives the follow-up too, not
  // an already-resolved one.
  it("resolves a second caller only once the follow-up has been written", async () => {
    const save = vi.fn(async (project: Project) => {
      await Promise.resolve();
      return reply(project);
    });
    const { saver } = harness(save);
    void saver.flush();
    const second = saver.flush();
    await second;
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports saving while a write is open and idle once it lands", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver, states } = harness(save);
    await saver.flush();
    expect(states).toEqual(["saving", "idle"]);
    expect(saver.getState()).toBe("idle");
  });
});

describe("the server's reply", () => {
  it("hands the reply to the caller, so the local version can follow the server's", async () => {
    const save = vi.fn(async (project: Project) => reply(project, 9_999));
    const { project, saver, saved } = harness(save);
    project.version = 4;
    await saver.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.version).toBe(5);
    expect(saved[0]?.updatedAt).toBe(9_999);
  });
});

describe("a conflict", () => {
  it("reloads from the 409 and reports the conflict", async () => {
    const server = fixtureProject({ version: 42 });
    const save = vi.fn(async () => {
      throw conflictError(server);
    });
    const { saver, conflicts, errors, states } = harness(save);
    await saver.flush();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.version).toBe(42);
    expect(errors).toHaveLength(0);
    expect(states).toEqual(["saving", "conflict"]);
    expect(saver.getState()).toBe("conflict");
  });

  it("does not retry the write that lost, so the reload is not clobbered", async () => {
    const save = vi.fn(async () => {
      throw conflictError(fixtureProject({ version: 42 }));
    });
    const { saver } = harness(save);
    await saver.flush();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).toHaveBeenCalledOnce();
  });

  it("leaves the conflict showing until the next save starts", async () => {
    let stale = true;
    const save = vi.fn(async (project: Project) => {
      if (stale) {
        stale = false;
        throw conflictError(fixtureProject({ version: 42 }));
      }
      return reply(project);
    });
    const { saver } = harness(save);
    await saver.flush();
    expect(saver.getState()).toBe("conflict");
    await saver.flush();
    expect(saver.getState()).toBe("idle");
  });

  it("reports a 409 it cannot reload from as a failure rather than guessing", async () => {
    const save = vi.fn(async () => {
      throw conflictError();
    });
    const { saver, conflicts, errors } = harness(save);
    await saver.flush();
    expect(conflicts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(saver.getState()).toBe("conflict");
  });
});

describe("a save that simply fails", () => {
  it("reports the error and says the change is still owed", async () => {
    const failure = new Error("Is the Slide Studio server still running?");
    const save = vi.fn(async () => {
      throw failure;
    });
    const { saver, errors, conflicts } = harness(save);
    await saver.flush();
    expect(errors).toEqual([failure]);
    expect(conflicts).toHaveLength(0);
    /*
     * This asserted "idle" until the editor needed to know whether an edit was
     * unsent. A write that failed never reached the server and nothing here
     * retries it, so "idle" claimed the document was clean when it was not, and
     * the editor read that and reloaded over the edit. The state now says what
     * is true: the change is still owed.
     */
    expect(saver.getState()).toBe("pending");
  });

  it("saves again on the next edit rather than giving up", async () => {
    let failures = 1;
    const save = vi.fn(async (project: Project) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      return reply(project);
    });
    const { saver, saved } = harness(save);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(1);
  });
});

// onStateChange is a caller-supplied listener (EditorStore wires it to
// publish(), which calls every store subscriber synchronously) and run() does
// not control what it does. A throw out of it on the "saving" transition used
// to escape setState() before deps.save() was ever called: the edit was never
// sent, and nothing recovered it, since the throw happened before armRetry()'s
// catch block could arm a retry. The indicator was then stuck reading "saving"
// forever. setState() now catches a listener's throw and reports it through
// onError instead of letting it interrupt the save it was called from.
describe("a listener that throws", () => {
  it("still sends the write when onStateChange throws on the saving transition", async () => {
    let saveCount = 0;
    let threw = false;
    const save = vi.fn(async (project: Project) => {
      saveCount += 1;
      return reply(project);
    });
    const project = fixtureProject();
    const saver = new Saver({
      save,
      project: () => project,
      onStateChange: (state) => {
        if (state === "saving" && !threw) {
          threw = true;
          throw new Error("listener boom");
        }
      },
      onError: () => {},
    });

    const counts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      saver.schedule();
      await saver.flush();
      counts.push(saveCount);
    }

    // Every attempt reaches the server, including the one whose "saving"
    // listener threw — the throw is reported, not swallowed into a lost edit.
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(saver.getState()).toBe("idle");
  });

  // A listener throwing on the SUCCESS path is a different failure mode: the
  // write already reached the server, so it must not be mistaken for a save
  // that failed. That used to make the editor toast a false "couldn't save"
  // error, mark a clean document "pending" again, and armRetry() a redundant
  // resend of a document already saved.
  it("does not mistake a listener throw on the idle transition for a failed save", async () => {
    let threw = false;
    const project = fixtureProject();
    const save = vi.fn(async (value: Project) => reply(value));
    const errors: unknown[] = [];
    const states: SaveState[] = [];
    const saver = new Saver({
      save,
      project: () => project,
      onStateChange: (state) => {
        states.push(state);
        if (state === "idle" && !threw) {
          threw = true;
          throw new Error("listener boom on idle");
        }
      },
      onError: (error) => errors.push(error),
    });

    saver.schedule();
    await saver.flush();

    // The listener's own throw is reported once...
    expect(errors).toHaveLength(1);
    // ...but the save itself is not resent, and the state settles on "idle"
    // rather than being flipped back to "pending" by a phantom failure.
    expect(save).toHaveBeenCalledOnce();
    expect(saver.getState()).toBe("idle");
    expect(states).toEqual(["pending", "saving", "idle"]);

    // Nothing was armed to retry a save that already succeeded.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(save).toHaveBeenCalledOnce();
  });
});

// Editor.tsx unmounts on navigate("/"), which is not awaited, so closing can
// land either before or after the save debounce has fired. Both orderings are
// pinned here with controlled timers rather than relying on a real component's
// nondeterministic race — a rerun of that race always favours one ordering, so
// it cannot prove the other is fixed.
describe("settling on close", () => {
  it("sends a still-pending edit exactly once, when close lands before the debounce fires", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver } = harness(save);

    saver.schedule();
    // Nothing has been sent yet, so settle() has to write it.
    await saver.settle();
    expect(save).toHaveBeenCalledOnce();

    // Nothing left owed, so time passing sends nothing more.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).toHaveBeenCalledOnce();
  });

  it("resends a write that already failed, when close lands after the debounce fires", async () => {
    let failures = 1;
    const save = vi.fn(async (project: Project) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      return reply(project);
    });
    const { saver } = harness(save);

    saver.schedule();
    // The debounce fires on its own, sends the one attempt, and it fails —
    // arming a backoff retry for later.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledOnce();

    // Close lands after that failed attempt. The document has never reached
    // the server, so this must send it again rather than waiting out (or
    // dropping) the backoff.
    await saver.settle();
    expect(save).toHaveBeenCalledTimes(2);

    // Already delivered by settle(), so the backoff that would have retried
    // it has nothing left to do: waiting past when it would have fired sends
    // nothing more.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  // The regression this whole describe block exists to catch: settle() was
  // briefly changed to drop an armed retry outright, which lost a still-owed
  // edit the moment a save happened to fail right before the editor closed.
  it("still delivers an edit that failed once, when the editor closes", async () => {
    const failure = new Error("offline");
    let attempts = 0;
    const save = vi.fn(async (project: Project) => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return reply(project);
    });
    const { project, saver, saved } = harness(save);

    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(saver.getState()).toBe("pending");

    await saver.settle();

    // Not just called again: the edit actually reached the server.
    expect(saved).toHaveLength(1);
    expect(save).toHaveBeenLastCalledWith(project);
  });

  it("does nothing when there was never anything to save", async () => {
    const save = vi.fn(async (project: Project) => reply(project));
    const { saver } = harness(save);
    await saver.settle();
    expect(save).not.toHaveBeenCalled();
  });

  // The precise race: `looping` flips to false, and armRetry() arms
  // retryTimer, in the same synchronous span in which run() decides to stop
  // — but `running` stays non-null for a few microtask ticks after that,
  // until the `.catch().finally()` flush() attached to run()'s own promise
  // actually runs and nulls it out (see settle()'s own doc comment). A
  // settle() landing in THAT gap — looping already false, retryTimer armed,
  // running still set — used to see `owed = true`, call flush(), find
  // `running` still truthy, and just queue a follow-up nothing was left to
  // service: the edit was lost outright, with no error and no future retry.
  //
  // Fix round 4's finding: calling `saver.settle()` synchronously from
  // inside the setTimeout() spy below — armRetry()'s last synchronous act —
  // does NOT land here. At that exact instant `retryTimer` has not been
  // assigned yet (armRetry() is still evaluating the assignment's right-hand
  // side) and `looping` is still true, so settle() takes its OWN
  // `await this.running` branch and does not resume until run() has fully
  // exited — the same safe landing point the deleted `it.each([0,1,2])` test
  // called "3+ hops … clears that window on its own". Deferring the
  // settle() call by exactly one microtask (`Promise.resolve().then(...)`,
  // not a bare `await` counted by hand) lands it deterministically inside
  // the real window instead: that one tick runs after the synchronous span
  // above (armRetry() returning, retryTimer assigned, looping flipped, and
  // run()'s own promise fulfilling — which enqueues the `.catch()` reaction
  // job before this deferred call even gets a chance to run) but strictly
  // before the `.catch()` reaction job's OWN completion enqueues the
  // `.finally()` job that nulls `running` — two further ticks away, not one.
  // Hooking setTimeout() is still what removes any dependence on how many
  // microtask ticks the engine takes to get there in the first place; the
  // one-tick defer only orders this call relative to that hook, which is a
  // fact about this module's own promise chain, not the engine.
  it("still delivers an edit whose save failed, settled inside the exact window between looping flipping false and running being nulled", async () => {
    let attempts = 0;
    const save = vi.fn(async (project: Project) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return reply(project);
    });
    const { saver } = harness(save);

    const fakeSetTimeout = globalThis.setTimeout;
    let settled: Promise<void> | undefined;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const timer = fakeSetTimeout(...args);
        // The debounce's own setTimeout (schedule(), not used here) and
        // armRetry()'s are the only callers; flush() is called directly
        // below, so the first call this spy sees is armRetry()'s. Deferred
        // by one microtask — see the comment above for why that, and not a
        // synchronous call here, is what actually lands inside the race.
        settled ??= Promise.resolve().then(() => saver.settle());
        return timer;
      });

    void saver.flush();
    let hops = 0;
    while (settled === undefined && hops < 20) {
      await Promise.resolve();
      hops += 1;
    }
    spy.mockRestore();
    expect(settled, "armRetry() never armed a retry").toBeDefined();

    await settled;
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("waits for a write already in flight rather than starting another", async () => {
    // Boxed, the way "one write at a time" above holds its gate: a bare `let`
    // reassigned only inside the executor leaves TS unable to see the
    // assignment has happened by the time it is called below.
    const gate: { release: () => void } = { release: () => {} };
    const save = vi.fn(
      (project: Project) =>
        new Promise<Project>((resolve) => {
          gate.release = () => resolve(reply(project));
        }),
    );
    const { saver } = harness(save);

    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();

    const settled = saver.settle();
    gate.release();
    await settled;
    expect(save).toHaveBeenCalledOnce();
  });
});

// Finding 4 from the multi-account review: armRetry() overwrote
// `retryTimer` with a new timeout without clearing the one it replaced. A
// queued follow-up (run()'s own loop, triggered when a second edit lands
// while an attempt is still on the wire) runs straight back through another
// attempt without going through cancel() — the only place that used to clear
// a stale retryTimer — so a first attempt's retry could still be armed when a
// second attempt's failure armed its own, replacing the reference and
// leaving the first timer running with nothing left to cancel it.
describe("a leaked retry timer", () => {
  it("clears a superseded retry instead of leaking it, so a stale save cannot resend behind a newer one", async () => {
    const pending: { reject: (error: Error) => void }[] = [];
    let call = 0;
    const save = vi.fn(
      (project: Project) =>
        new Promise<Project>((resolve, reject) => {
          call += 1;
          if (call <= 2) {
            pending.push({ reject });
          } else {
            resolve(reply(project));
          }
        }),
    );
    const { saver } = harness(save);

    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);

    // A second edit lands while attempt 1 is still on the wire: flush() sees
    // `looping` and queues a follow-up rather than starting a fresh cycle.
    void saver.flush();

    // Attempt 1 fails. armRetry() arms a 1s retry (T1).
    pending[0]?.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);

    // The queued follow-up runs straight back through the loop, without
    // cancel(): attempt 2 starts on its own.
    expect(save).toHaveBeenCalledTimes(2);

    // Attempt 2 fails too. armRetry() arms a 2s retry (T2). Fixed, this
    // clears T1 first; broken, T1 is left running underneath T2 with no
    // reference left to cancel it.
    pending[1]?.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);

    // T1's original 1s mark passes. Leaked, it fires here and resends a
    // save behind T2's back; fixed, nothing is armed at this mark any more.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(save).toHaveBeenCalledTimes(2);

    // T2's own 2s mark: the one retry actually owed fires and lands.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(save).toHaveBeenCalledTimes(3);
    expect(saver.getState()).toBe("idle");
  });

  it("lets settle() cancel the one retry actually owed, instead of a leaked timer surviving to fire after the editor is disposed", async () => {
    const pending: { reject: (error: Error) => void }[] = [];
    let call = 0;
    const save = vi.fn(
      (project: Project) =>
        new Promise<Project>((resolve, reject) => {
          call += 1;
          if (call <= 2) {
            pending.push({ reject });
          } else {
            resolve(reply(project));
          }
        }),
    );
    const { saver } = harness(save);

    saver.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    void saver.flush();
    pending[0]?.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    pending[1]?.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);

    // The editor closes before either backoff fires. settle() sees the write
    // is still owed, sends it once more (to completion this time), and must
    // leave nothing scheduled behind it — cancel()'s clearTimeout only has a
    // handle on whichever timer `retryTimer` currently names.
    await saver.settle();
    expect(save).toHaveBeenCalledTimes(3);

    // Both retries' original marks pass with the editor already disposed. A
    // leaked timer firing here would save a document nothing is editing any
    // more, against a saver that has already settled.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(save).toHaveBeenCalledTimes(3);
  });
});
