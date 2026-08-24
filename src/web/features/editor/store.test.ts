import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Slide } from "@shared/schema/index.js";
import { activeSlideOf, EditorStore } from "./store.js";
import { HISTORY_LIMIT } from "./history.js";
import { SAVE_DEBOUNCE_MS } from "./persistence.js";
import type { ConflictError } from "./persistence.js";
import type { LayerKey } from "./selection.js";
import { fixtureProject } from "./testing.js";

/** The server's reply: the same project, one version on. */
function reply(project: Project, updatedAt = 2_000): Project {
  return { ...structuredClone(project), version: project.version + 1, updatedAt };
}

function conflictError(project?: Project): ConflictError {
  return Object.assign(new Error("This slideshow changed since you loaded it."), {
    status: 409 as const,
    project,
  });
}

function secondSlide(): Slide {
  const slide = fixtureProject({ slides: 2 }).slides[1];
  if (!slide) throw new Error("the fixture must build a second slide");
  return slide;
}

const savesFine = () => vi.fn(async (project: Project) => reply(project));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notifying React", () => {
  it("notifies subscribers when the document changes", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    /*
     * Twice, because one edit moves two things: the document, and the save
     * state, which now reports "pending" the moment a change is owed rather
     * than staying "idle" until the debounce fires. Only the first edit of a
     * burst costs the second notification, since the state is already pending
     * for the rest of it, and React coalesces two adjacent notifications into
     * one render anyway.
     */
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns a new snapshot object after a change, so React re-renders", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const before = store.getSnapshot();
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    expect(store.getSnapshot()).not.toBe(before);
  });

  it("keeps the same snapshot when nothing was asked to change", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const before = store.getSnapshot();
    store.setActiveSlide("no-such-slide");
    store.undo();
    store.redo();
    expect(store.getSnapshot()).toBe(before);
  });

  it("stops notifying an unsubscribed listener", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const listener = vi.fn();
    store.subscribe(listener)();
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("hands out the live document, so a drag can move a layer without a copy", () => {
    const project = fixtureProject();
    const store = new EditorStore(project, { save: vi.fn() });
    expect(store.getSnapshot().project).toBe(project);
  });

  it("finds the active slide from a snapshot", () => {
    const store = new EditorStore(fixtureProject({ slides: 2 }), { save: vi.fn() });
    expect(activeSlideOf(store.getSnapshot())?.id).toBe("slide-1");
    store.setActiveSlide("slide-2");
    expect(activeSlideOf(store.getSnapshot())?.id).toBe("slide-2");
  });
});

describe("undo", () => {
  it("records one undo entry for a whole transaction", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.transaction(() => {
      for (let step = 0; step < 10; step += 1) {
        store.mutate((document) => {
          document.slides[0]!.texts[0]!.x += 0.01;
        });
      }
    });
    store.undo();
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
  });

  // A drag of sixty frames is sixty mutates. Sixty entries would be a broken
  // editor, so the count matters as much as the value.
  it("leaves nothing to undo after undoing one transaction", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.transaction(() => {
      for (let step = 0; step < 60; step += 1) {
        store.mutate((document) => {
          document.slides[0]!.texts[0]!.x += 0.001;
        });
      }
    });
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.canUndo()).toBe(false);
  });

  it("keeps a nested transaction inside the outer one entry", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.transaction(() => {
      store.mutate((document) => {
        document.slides[0]!.texts[0]!.x = 0.2;
      });
      store.transaction(() => {
        store.mutate((document) => {
          document.slides[0]!.texts[0]!.x = 0.3;
        });
      });
    });
    store.undo();
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
    expect(store.canUndo()).toBe(false);
  });

  // app.js:3977 records at pointer-down, before it knows whether the pointer
  // will move at all, so a click that starts a drag and ends it costs an entry.
  it("records a transaction that changed nothing, the way pointer-down does", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.transaction(() => {});
    expect(store.canUndo()).toBe(true);
  });

  it("records nothing when history is turned off for a step", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.mutate(
      (document) => {
        document.slides[0]!.texts[0]!.x = 0.5;
      },
      { history: false },
    );
    expect(store.canUndo()).toBe(false);
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.5, 6);
  });

  it("caps the undo stack at two hundred entries", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    for (let step = 0; step < HISTORY_LIMIT + 50; step += 1) {
      store.mutate((document) => {
        document.slides[0]!.texts[0]!.x = step / 1000;
      });
    }
    for (let step = 0; step < HISTORY_LIMIT; step += 1) store.undo();
    expect(store.canUndo()).toBe(false);
    // Fifty entries fell off the bottom, so the oldest reachable state is the
    // one recorded before edit fifty, not the document the store opened with.
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.049, 6);
  });

  it("clears the redo stack on a new edit", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.7;
    });
    expect(store.canRedo()).toBe(false);
  });

  it("steps back and forward over the same edits", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const x = () => store.getSnapshot().project.slides[0]!.texts[0]!.x;
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.2;
    });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.3;
    });
    store.undo();
    expect(x()).toBeCloseTo(0.2, 6);
    store.undo();
    expect(x()).toBeCloseTo(0.06, 6);
    store.redo();
    expect(x()).toBeCloseTo(0.2, 6);
    store.redo();
    expect(x()).toBeCloseTo(0.3, 6);
    expect(store.canRedo()).toBe(false);
  });

  it("keeps the active slide when undo removes the slide it pointed at", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.mutate((document) => {
      document.slides.push(secondSlide());
    });
    store.setActiveSlide("slide-2");
    expect(store.getSnapshot().activeSlideId).toBe("slide-2");
    store.undo();
    expect(store.getSnapshot().activeSlideId).toBe("slide-1");
  });

  it("drops a selection whose layer no longer exists", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.select(["text:text-1-1", "overlay:overlay-1-1"] as LayerKey[]);
    expect(store.getSnapshot().selection).toEqual([
      "text:text-1-1",
      "overlay:overlay-1-1",
    ]);
    store.mutate((document) => {
      document.slides[0]!.overlays = [];
    });
    expect(store.getSnapshot().selection).toEqual(["text:text-1-1"]);
    expect(store.getSnapshot().primary).toBe("text:text-1-1");
  });

  it("empties a selection whose every layer went, rather than throwing", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.selectOnly("text", "text-1-1");
    store.mutate((document) => {
      document.slides[0]!.texts = [];
    });
    expect(store.getSnapshot().selection).toEqual([]);
    expect(store.getSnapshot().primary).toBeNull();
  });

  // try/finally already holds this. Nothing said so, which left the next
  // person to touch transaction one edit away from a silent depth leak that
  // would merge every later edit into one undo entry forever.
  it("does not leak the transaction when the body throws", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const x = () => store.getSnapshot().project.slides[0]!.texts[0]!.x;
    expect(() =>
      store.transaction(() => {
        store.mutate((document) => {
          document.slides[0]!.texts[0]!.x = 0.2;
        });
        throw new Error("the drag handler blew up");
      }),
    ).toThrow("the drag handler blew up");

    // The edit after the throw must record its own entry, not join the one the
    // abandoned transaction opened.
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.3;
    });
    store.undo();
    expect(x()).toBeCloseTo(0.2, 6);
    store.undo();
    expect(x()).toBeCloseTo(0.06, 6);
    expect(store.canUndo()).toBe(false);
  });

  /**
   * Crop mode points at one overlay, so it dangles exactly the way a selection
   * key does. An editor still cropping an overlay that is no longer on the
   * slide has no way back out.
   */
  it("drops crop mode when the overlay it points at is deleted", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.setCropping("overlay-1-1");
    store.mutate((document) => {
      document.slides[0]!.overlays = [];
    });
    expect(store.getSnapshot().croppingOverlayId).toBeNull();
  });

  it("keeps crop mode when a different overlay is deleted", () => {
    const store = new EditorStore(fixtureProject({ overlays: 2 }), { save: vi.fn() });
    store.setCropping("overlay-1-2");
    store.mutate((document) => {
      document.slides[0]!.overlays = document.slides[0]!.overlays.filter(
        (overlay) => overlay.id !== "overlay-1-1",
      );
    });
    expect(store.getSnapshot().croppingOverlayId).toBe("overlay-1-2");
  });

  it("leaves crop mode when history moves the document under it", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.mutate((document) => {
      document.slides[0]!.overlays[0]!.width = 0.5;
    });
    store.setCropping("overlay-1-1");
    store.undo();
    expect(store.getSnapshot().croppingOverlayId).toBeNull();
  });
});

describe("selection", () => {
  it("selects one layer and makes it primary", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.selectOnly("overlay", "overlay-1-1");
    expect(store.getSnapshot().selection).toEqual(["overlay:overlay-1-1"]);
    expect(store.getSnapshot().primary).toBe("overlay:overlay-1-1");
  });

  it("adds and removes a layer on toggle", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.selectOnly("text", "text-1-1");
    store.toggleSelect("overlay", "overlay-1-1");
    expect(store.getSnapshot().selection).toHaveLength(2);
    store.toggleSelect("overlay", "overlay-1-1");
    expect(store.getSnapshot().selection).toEqual(["text:text-1-1"]);
  });

  it("ignores a layer that is not on the active slide", () => {
    const store = new EditorStore(fixtureProject({ slides: 2 }), { save: vi.fn() });
    store.selectOnly("text", "text-2-1");
    expect(store.getSnapshot().selection).toEqual([]);
  });

  it("clears the selection when the slide changes, since a selection belongs to its slide", () => {
    const store = new EditorStore(fixtureProject({ slides: 2, overlays: 1 }), {
      save: vi.fn(),
    });
    store.selectOnly("text", "text-1-1");
    store.setCropping("overlay-1-1");
    expect(store.getSnapshot().croppingOverlayId).toBe("overlay-1-1");
    store.setActiveSlide("slide-2");
    expect(store.getSnapshot().selection).toEqual([]);
    expect(store.getSnapshot().croppingOverlayId).toBeNull();
  });

  it("refuses a slide id the project does not hold", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.setActiveSlide("slide-9");
    expect(store.getSnapshot().activeSlideId).toBe("slide-1");
  });

  it("empties the selection and leaves crop mode on clear", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.selectOnly("overlay", "overlay-1-1");
    store.setCropping("overlay-1-1");
    store.clearSelection();
    expect(store.getSnapshot().selection).toEqual([]);
    expect(store.getSnapshot().croppingOverlayId).toBeNull();
  });
});

/**
 * Neither of these goes through mutate. The document, the name, and the status
 * take three different paths to the server, and one recipe signature cannot
 * describe all three.
 */
describe("the project's own fields", () => {
  it("renames and schedules a save", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.rename("A better title");
    expect(store.getSnapshot().project.name).toBe("A better title");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].name).toBe("A better title");
  });

  it("falls back to a default rather than letting the title go empty", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.rename("");
    expect(store.getSnapshot().project.name).toBe("New Project");
  });

  // app.js:2160 never records one, and a history entry holds the document
  // alone, so an entry here could not undo the rename anyway.
  it("records no undo entry for a rename", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    store.rename("A better title");
    expect(store.canUndo()).toBe(false);
  });

  /**
   * Every other assertion here reads through getSnapshot().project, which is
   * the live object, so it would pass with the publish deleted. React would
   * then never re-render, and a controlled title input would look frozen while
   * the user typed into it.
   */
  it("publishes the rename, so a controlled input re-renders", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    store.rename("A better title");
    // As above: the name moved and the save state moved with it.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().project.name).toBe("A better title");
  });

  it("notifies once and does nothing when the name has not moved", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.rename("Fixture");
    expect(listener).not.toHaveBeenCalled();
  });

  it("shows a new status straight away and tells the server", async () => {
    const setStatus = vi.fn(async () => ({}));
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save, setStatus });
    const pending = store.setStatus("ready");
    expect(store.getSnapshot().project.status).toBe("ready");
    await pending;
    expect(setStatus).toHaveBeenCalledWith("project-1", "ready");
  });

  /**
   * The server writes status without the version guard and without touching
   * the version (src/server/services/projects.ts:69-84), precisely so that
   * marking something ready cannot make an open editor's next save conflict.
   * Routing it through the debounced save would undo that.
   */
  it("does not put the status on the document save, and takes no undo entry", async () => {
    const setStatus = vi.fn(async () => ({}));
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save, setStatus });
    await store.setStatus("ready");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("puts the old status back when the server refuses", async () => {
    const failure = new Error("Could not change the status.");
    const onError = vi.fn();
    const store = new EditorStore(fixtureProject(), {
      save: vi.fn(),
      setStatus: async () => {
        throw failure;
      },
      onError,
    });
    await store.setStatus("published");
    expect(store.getSnapshot().project.status).toBe("draft");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("publishes the new status, and publishes the rollback too", async () => {
    const seen: string[] = [];
    const store = new EditorStore(fixtureProject(), {
      save: vi.fn(),
      setStatus: async () => {
        throw new Error("Could not change the status.");
      },
    });
    store.subscribe(() => seen.push(store.getSnapshot().project.status));
    await store.setStatus("published");
    expect(seen).toEqual(["published", "draft"]);
  });

  /**
   * An agent's change reaches an open editor over the event stream, and
   * handleServerEvent adopts it without calling the API (app.js:1128-1133).
   * Writing it back would be a round trip that says nothing, and a rollback on
   * failure would fight the server over a status it already holds.
   */
  it("adopts a status the server already holds, without writing it back", async () => {
    const setStatus = vi.fn(async () => ({}));
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save, setStatus });
    const listener = vi.fn();
    store.subscribe(listener);

    await store.setStatus("published", { fromServer: true });

    expect(store.getSnapshot().project.status).toBe("published");
    expect(listener).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
  });

  it("never rolls back a status the server pushed", async () => {
    const store = new EditorStore(fixtureProject(), {
      save: vi.fn(),
      setStatus: async () => {
        throw new Error("this endpoint must not be reached");
      },
    });
    await store.setStatus("ready", { fromServer: true });
    expect(store.getSnapshot().project.status).toBe("ready");
  });

  it("does nothing when the status has not moved", async () => {
    const setStatus = vi.fn(async () => ({}));
    const store = new EditorStore(fixtureProject(), { save: vi.fn(), setStatus });
    await store.setStatus("draft");
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("moving a layer", () => {
  it("reorders through one undo entry", () => {
    const store = new EditorStore(fixtureProject({ overlays: 1 }), { save: vi.fn() });
    store.moveLayer("overlay", "overlay-1-1", "front");
    const slide = activeSlideOf(store.getSnapshot());
    expect(slide?.overlays[0]?.z).toBe(2);
    expect(slide?.texts[0]?.z).toBe(1);
    store.undo();
    expect(activeSlideOf(store.getSnapshot())?.overlays[0]?.z).toBe(1);
  });

  it("carries the whole selection when the moved layer is in it", () => {
    const store = new EditorStore(fixtureProject({ overlays: 2, texts: 2 }), {
      save: vi.fn(),
    });
    store.select(["overlay:overlay-1-1", "overlay:overlay-1-2"] as LayerKey[]);
    store.moveLayer("overlay", "overlay-1-1", "front");
    const slide = activeSlideOf(store.getSnapshot());
    expect(slide?.overlays.map((overlay) => overlay.z)).toEqual([3, 4]);
    expect(slide?.texts.map((text) => text.z)).toEqual([1, 2]);
  });
});

describe("saving", () => {
  it("debounces a burst of edits into one save", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    for (let step = 0; step < 3; step += 1) {
      store.mutate((document) => {
        document.slides[0]!.texts[0]!.x = step / 10;
      });
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save a mutate that asked not to be saved", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.mutate(
      (document) => {
        document.slides[0]!.texts[0]!.x = 0.5;
      },
      { save: false },
    );
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
  });

  it("bumps the local version from the server's reply", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject({ version: 4 }), { save });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(store.getSnapshot().project.version).toBe(5);
    expect(store.getSnapshot().project.updatedAt).toBe(2_000);
  });

  /**
   * app.js:341-346 takes exactly two fields back out of the reply. The reply
   * here disagrees with the local project on every other field, so adopting
   * any of them shows up, and `this.project = saved` cannot pass.
   */
  it("takes only version and updatedAt from the reply, and nothing else", async () => {
    const save = vi.fn(async (project: Project) => ({
      ...structuredClone(project),
      version: project.version + 1,
      updatedAt: 2_000,
      name: "Name from the server",
      status: "published" as const,
      ratio: { w: 1, h: 1 },
      slides: [],
    }));
    const store = new EditorStore(fixtureProject({ version: 4 }), { save });
    await store.flush();
    const project = store.getSnapshot().project;
    expect(project.version).toBe(5);
    expect(project.updatedAt).toBe(2_000);
    expect(project.name).toBe("Fixture");
    expect(project.status).toBe("draft");
    expect(project.ratio).toEqual({ w: 9, h: 16 });
    expect(project.slides).toHaveLength(1);
  });

  // The rename lands after save() has already taken its argument, which is the
  // only ordering where a reply-shaped rollback could actually eat it.
  it("keeps a rename made while the write was in flight", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const save = vi.fn(async (project: Project) => {
      const sent = structuredClone(project);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { ...sent, version: sent.version + 1, updatedAt: 2_000 };
    });
    const store = new EditorStore(fixtureProject(), { save });
    const writing = store.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();

    store.rename("Renamed mid-flight");
    gate.release();
    await writing;
    expect(store.getSnapshot().project.name).toBe("Renamed mid-flight");
  });

  it("reports saving while a write is open", async () => {
    const seen: string[] = [];
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.subscribe(() => seen.push(store.getSnapshot().saveState));
    await store.flush();
    expect(seen).toContain("saving");
    expect(store.getSnapshot().saveState).toBe("idle");
  });

  it("hands a failed save to the caller and stays out of the conflict state", async () => {
    const failure = new Error("offline");
    const onError = vi.fn();
    const store = new EditorStore(fixtureProject(), {
      save: async () => {
        throw failure;
      },
      onError,
    });
    await store.flush();
    expect(onError).toHaveBeenCalledWith(failure);
    /*
     * "pending", not "idle". The write never reached the server and nothing
     * retries it, so the change is still owed; reporting "idle" claimed the
     * document was clean and let the editor reload over an edit that existed
     * nowhere else.
     */
    expect(store.getSnapshot().saveState).toBe("pending");
  });

  // app.js:169 flushes rather than schedules, so an undo is on the server
  // before the user can close the tab.
  it("saves an undo at once rather than waiting out the debounce", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    save.mockClear();
    store.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
  });

  /**
   * The divergence from app.js that matters most. cloneProject snapshots the
   * version alongside the document (app.js:139-148) and applyHistorySnapshot
   * puts it back (app.js:164), so in the old editor the save that follows an
   * undo carries a version the server has already moved past, takes a 409, and
   * reloads away the undo.
   */
  it("does not roll the version back on undo, so the save that follows it lands", async () => {
    const sent: number[] = [];
    const save = vi.fn(async (project: Project) => {
      sent.push(project.version);
      return reply(project);
    });
    const store = new EditorStore(fixtureProject({ version: 1 }), { save });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(store.getSnapshot().project.version).toBe(2);
    store.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([1, 2]);
    expect(store.getSnapshot().project.version).toBe(3);
  });
});

describe("a conflict", () => {
  it("reloads the project and reports a conflict on 409", async () => {
    const server = fixtureProject({ version: 42 });
    server.slides[0]!.texts[0]!.text = "Written by an agent";
    const store = new EditorStore(fixtureProject(), {
      save: async () => {
        throw conflictError(server);
      },
    });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    // Not an identity check: the payload is repaired on the way in, so the
    // store holds a parsed copy rather than the object the error carried.
    expect(store.getSnapshot().project).not.toBe(server);
    expect(store.getSnapshot().project.version).toBe(42);
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.text).toBe(
      "Written by an agent",
    );
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
    expect(store.getSnapshot().saveState).toBe("conflict");
  });

  it("does not undo past the conflict reload", async () => {
    const server = fixtureProject({ version: 42 });
    server.slides[0]!.texts[0]!.text = "Written by an agent";
    const store = new EditorStore(fixtureProject(), {
      save: async () => {
        throw conflictError(server);
      },
    });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    expect(store.canUndo()).toBe(true);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    const before = store.getSnapshot();
    store.undo();
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.text).toBe(
      "Written by an agent",
    );
  });

  /**
   * app.js:1109 runs normalizeProject over the reloaded project. Skipping it
   * would let a conflict reload install a document that never got its defaults
   * or its z back-fill, which every other entry point into the editor does get.
   */
  it("repairs the payload before it becomes the live project", async () => {
    const raw = fixtureProject({ version: 42, overlays: 1 });
    // A stored overlay with no z and a text with a broken size: exactly what
    // normalizeProject and the schema exist to put right.
    delete raw.slides[0]!.overlays[0]!.z;
    delete raw.slides[0]!.texts[0]!.z;
    (raw.slides[0]!.texts[0] as { size: unknown }).size = "not a number";
    const store = new EditorStore(fixtureProject(), {
      save: async () => {
        throw conflictError(raw);
      },
    });
    await store.flush();
    const slide = activeSlideOf(store.getSnapshot());
    expect(slide?.overlays[0]?.z).toBe(1);
    expect(slide?.texts[0]?.z).toBe(2);
    expect(slide?.texts[0]?.size).toBe(48);
  });

  /**
   * conflictProject admits any payload whose slides is an array, but
   * projectSchema requires id, version and createdAt and gives none of them a
   * .catch(). So parseProject can throw from inside onConflict, which Saver
   * calls inside its own catch block. Left unguarded that skips the state
   * change and wedges the editor at "saving" while it holds a stale document:
   * the user keeps typing into something that will never persist, and nothing
   * says so.
   */
  it("does not wedge when the payload cannot be parsed", async () => {
    const malformed = { slides: [], ratio: { w: 9, h: 16 } } as unknown as Project;
    const onError = vi.fn();
    let stale = true;
    const save = vi.fn(async (project: Project) => {
      if (stale) {
        stale = false;
        throw conflictError(malformed);
      }
      return reply(project);
    });
    const store = new EditorStore(fixtureProject(), { save, onError });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    // The write lost, so the state says so rather than claiming to be saving.
    expect(store.getSnapshot().saveState).toBe("conflict");
    expect(onError).toHaveBeenCalledOnce();
    // The document is untouched: a payload that cannot be parsed replaces nothing.
    expect(store.getSnapshot().project.slides).toHaveLength(1);
    expect(store.getSnapshot().project.slides[0]!.texts[0]!.x).toBeCloseTo(0.5, 6);

    // And the saver still works, which is what "wedged" would rule out.
    await store.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().saveState).toBe("idle");
  });

  it("moves the active slide and the selection onto the reloaded document", async () => {
    const server = fixtureProject({ version: 42 });
    const store = new EditorStore(fixtureProject({ slides: 2 }), {
      save: async () => {
        throw conflictError(server);
      },
    });
    store.setActiveSlide("slide-2");
    store.selectOnly("text", "text-2-1");
    await store.flush();
    expect(store.getSnapshot().activeSlideId).toBe("slide-1");
    expect(store.getSnapshot().selection).toEqual([]);
  });

  it("goes back to idle on the next save that lands", async () => {
    let stale = true;
    const store = new EditorStore(fixtureProject(), {
      save: async (project: Project) => {
        if (stale) {
          stale = false;
          throw conflictError(fixtureProject({ version: 42 }));
        }
        return reply(project);
      },
    });
    await store.flush();
    expect(store.getSnapshot().saveState).toBe("conflict");
    await store.flush();
    expect(store.getSnapshot().saveState).toBe("idle");
  });
});

describe("shutting down", () => {
  /**
   * app.js keeps its save timer in a module global that outlives the editor
   * view, so an edit made a moment before navigating away still reaches the
   * server. Dropping the timer here would lose that edit, quietly and
   * unreproducibly.
   */
  it("writes a pending edit instead of dropping it", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await store.dispose();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].slides[0]!.texts[0]!.x).toBeCloseTo(0.5, 6);
  });

  /**
   * Ordering, not microtask counting. Asserting only that the save happened
   * lets a dispose that never waits pass, because releasing the gate queues
   * the save's continuation before the assertion runs anyway. Recording when
   * dispose itself resolves is what makes the wait load-bearing: a dispose
   * returning an already-resolved promise settles before the gate is even
   * released, so "closed" lands first.
   */
  it("waits for a write already in flight", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const order: string[] = [];
    const save = vi.fn(async (project: Project) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      order.push("saved");
      return reply(project);
    });
    const store = new EditorStore(fixtureProject(), { save });
    void store.flush();
    await vi.advanceTimersByTimeAsync(0);

    const closing = store.dispose().then(() => {
      order.push("closed");
    });
    gate.release();
    await closing;
    expect(order).toEqual(["saved", "closed"]);
  });

  it("writes nothing when the editor was never touched", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    await store.dispose();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * dispose latches. A pointer handler or a debounced input can fire after
   * teardown, and re-arming the saver then would put a write on the wire for
   * an editor nobody is looking at.
   */
  it("stays closed, so a later edit cannot re-arm the saver", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    await store.dispose();
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    store.rename("Renamed after closing");
    await store.setStatus("ready");
    await store.flush();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(save).not.toHaveBeenCalled();
  });

  it("closes once, so a second call does not write again", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    await store.dispose();
    await store.dispose();
    expect(save).toHaveBeenCalledOnce();
  });

  // A second close must not resolve early. A caller awaiting it is asking
  // whether the editor is safely shut, and answering yes while a write is
  // still open is the same lie dropping the pending edit was.
  it("hands a second close the same wait as the first", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const order: string[] = [];
    const save = vi.fn(async (project: Project) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      order.push("saved");
      return reply(project);
    });
    const store = new EditorStore(fixtureProject(), { save });
    void store.flush();
    await vi.advanceTimersByTimeAsync(0);

    const first = store.dispose().then(() => {
      order.push("first");
    });
    const second = store.dispose().then(() => {
      order.push("second");
    });
    gate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["saved", "first", "second"]);
  });

  it("stops notifying once closed", async () => {
    const store = new EditorStore(fixtureProject(), { save: savesFine() });
    const listener = vi.fn();
    store.subscribe(listener);
    await store.dispose();
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the caption", () => {
  it("counts as unsaved the moment it is typed, and rides the next save", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });

    store.setDescription("Five things to know first");
    /*
     * The state, not just the field. "pending" is what defers an agent's reload
     * and raises the unload prompt, so a caption written straight onto the
     * project without the saver would read as idle and be lost with nothing on
     * screen to say so.
     */
    expect(store.getSnapshot().saveState).toBe("pending");
    expect(store.getSnapshot().project.description).toBe("Five things to know first");

    store.setHashtags("#travel #summer");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].description).toBe("Five things to know first");
    expect(save.mock.calls[0]?.[0].hashtags).toBe("#travel #summer");
    expect(store.getSnapshot().saveState).toBe("idle");
  });

  it("publishes, so a controlled field re-renders as it is typed", () => {
    const store = new EditorStore(fixtureProject(), { save: vi.fn() });
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setDescription("Typed");
    // The caption moved and the save state moved with it, as a rename does.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).not.toBe(before);
  });

  it("does nothing at all when the caption has not moved", () => {
    const save = vi.fn();
    const store = new EditorStore(
      { ...fixtureProject(), description: "Written", hashtags: "#travel" },
      { save },
    );
    const listener = vi.fn();
    store.subscribe(listener);
    store.setDescription("Written");
    store.setHashtags("#travel");
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().saveState).toBe("idle");
  });

  /*
   * A history entry holds the document alone (snapshotDocument), so an entry
   * recorded for a caption could restore nothing and would undo the reader's
   * last slide edit instead.
   */
  it("records no undo entry, and an undo leaves it alone", () => {
    const store = new EditorStore(fixtureProject(), { save: savesFine() });
    store.mutate((document) => {
      document.slides[0]!.texts[0]!.x = 0.5;
    });
    store.setDescription("Written after the edit");
    expect(store.canUndo()).toBe(true);

    store.undo();

    expect(store.getSnapshot().project.slides[0]?.texts[0]?.x).not.toBe(0.5);
    expect(store.getSnapshot().project.description).toBe("Written after the edit");
  });

  it("writes nothing once the editor is closed", async () => {
    const save = savesFine();
    const store = new EditorStore(fixtureProject(), { save });
    await store.dispose();
    store.setDescription("Too late");
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).not.toHaveBeenCalled();
    expect(store.getSnapshot().project.description).toBe("");
  });
});
