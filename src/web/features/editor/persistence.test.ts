import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/schema/index.js";
import {
  conflictProject,
  isConflictError,
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
