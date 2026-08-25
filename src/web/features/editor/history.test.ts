import { describe, expect, it } from "vitest";
import { History, HISTORY_LIMIT, restoreDocument, snapshotDocument } from "./history.js";
import type { DocumentSnapshot } from "./history.js";
import { fixtureProject } from "./testing.js";

describe("the undo stacks", () => {
  it("hands back what was recorded, newest first", () => {
    const history = new History<string>();
    history.record("one");
    history.record("two");
    expect(history.undo("now")).toBe("two");
    expect(history.undo("two")).toBe("one");
  });

  it("has nothing to undo before the first edit", () => {
    const history = new History<string>();
    expect(history.canUndo()).toBe(false);
    expect(history.undo("now")).toBeNull();
  });

  it("does not bank the current state when there is nothing to undo", () => {
    const history = new History<string>();
    expect(history.undo("now")).toBeNull();
    expect(history.canRedo()).toBe(false);
  });

  it("redoes what undo banked", () => {
    const history = new History<string>();
    history.record("one");
    expect(history.undo("two")).toBe("one");
    expect(history.canRedo()).toBe(true);
    expect(history.redo("one")).toBe("two");
  });

  it("clears the redo stack on a new edit", () => {
    const history = new History<string>();
    history.record("one");
    history.undo("two");
    expect(history.canRedo()).toBe(true);
    history.record("three");
    expect(history.canRedo()).toBe(false);
  });

  it("caps the undo stack at two hundred entries", () => {
    const history = new History<number>(HISTORY_LIMIT);
    for (let step = 0; step < HISTORY_LIMIT + 50; step += 1) history.record(step);
    expect(history.sizes.past).toBe(HISTORY_LIMIT);
    // The cap drops the oldest, so the reachable floor is entry 50, not entry 0.
    for (let step = 0; step < HISTORY_LIMIT - 1; step += 1) history.undo(-1);
    expect(history.undo(-1)).toBe(50);
    expect(history.canUndo()).toBe(false);
  });

  // The limit guards new edits, so a full sweep back and forward through a full
  // stack neither trims an entry nor grows past the cap.
  it("does not trim while stepping back through history", () => {
    const history = new History<number>(HISTORY_LIMIT);
    for (let step = 0; step < HISTORY_LIMIT; step += 1) history.record(step);
    let current = HISTORY_LIMIT;
    for (let step = 0; step < HISTORY_LIMIT; step += 1) {
      const snapshot = history.undo(current);
      expect(snapshot).toBe(HISTORY_LIMIT - 1 - step);
      current = snapshot ?? current;
    }
    expect(history.sizes).toEqual({ past: 0, future: HISTORY_LIMIT });
    for (let step = 0; step < HISTORY_LIMIT; step += 1) {
      const snapshot = history.redo(current);
      expect(snapshot).toBe(step + 1);
      current = snapshot ?? current;
    }
    expect(history.sizes).toEqual({ past: HISTORY_LIMIT, future: 0 });
  });

  it("empties both stacks on clear", () => {
    const history = new History<string>();
    history.record("one");
    history.undo("two");
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe("document snapshots", () => {
  it("copies the document deeply, so a later edit cannot reach into the entry", () => {
    const project = fixtureProject({ overlays: 1 });
    const snapshot = snapshotDocument(project);
    project.slides[0]!.texts[0]!.x = 0.9;
    project.slides[0]!.overlays[0]!.width = 0.9;
    project.ratio.w = 1;
    project.slides.push(structuredClone(project.slides[0]!));
    expect(snapshot.slides).toHaveLength(1);
    expect(snapshot.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
    expect(snapshot.slides[0]!.overlays[0]!.width).toBeCloseTo(0.34, 6);
    expect(snapshot.ratio.w).toBe(9);
  });

  it("restores a document without reusing the entry, so the next edit cannot corrupt it", () => {
    const project = fixtureProject();
    const snapshot = snapshotDocument(project);
    project.slides[0]!.texts[0]!.x = 0.9;
    restoreDocument(project, snapshot);
    project.slides[0]!.texts[0]!.x = 0.4;
    expect(snapshot.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
  });

  /**
   * The divergence from app.js worth guarding hardest. cloneProject
   * (app.js:139-148) snapshots the whole project and applyHistorySnapshot
   * (app.js:164) puts the whole thing back, so an undo also rolls back the
   * version, the name and the status. Nothing that changes those records
   * history, and rolling the version back makes the save that follows the undo
   * take a 409 and reload away the edit the user just undid.
   */
  it("leaves the fields history never recorded alone", () => {
    const project = fixtureProject({ version: 3 });
    const snapshot = snapshotDocument(project);
    project.version = 9;
    project.name = "Renamed after the snapshot";
    project.status = "published";
    project.updatedAt = 42;
    project.slides[0]!.texts[0]!.x = 0.9;

    restoreDocument(project, snapshot);

    expect(project.slides[0]!.texts[0]!.x).toBeCloseTo(0.06, 6);
    expect(project.version).toBe(9);
    expect(project.name).toBe("Renamed after the snapshot");
    expect(project.status).toBe("published");
    expect(project.updatedAt).toBe(42);
  });
});

/**
 * Over a long run of edits and steps through history, undo always lands on the
 * document that was current when the matching entry was recorded. The sequence
 * is driven by a fixed generator so a failure is reproducible.
 */
describe("record and undo agree over a long session", () => {
  it("restores the document that was current at each recorded step", () => {
    const project = fixtureProject({ slides: 2, texts: 2, overlays: 1 });
    const history = new History<DocumentSnapshot>(HISTORY_LIMIT);
    const expected: number[] = [];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let step = 0; step < 120; step += 1) {
      const roll = next();
      if (roll < 0.6 || !history.canUndo()) {
        history.record(snapshotDocument(project));
        expected.push(project.slides[0]!.texts[0]!.x);
        project.slides[0]!.texts[0]!.x = next();
      } else {
        const snapshot = history.undo(snapshotDocument(project));
        if (!snapshot) throw new Error("canUndo promised an entry");
        restoreDocument(project, snapshot);
        const wanted = expected.pop();
        expect(wanted).toBeDefined();
        expect(project.slides[0]!.texts[0]!.x).toBeCloseTo(wanted!, 12);
      }
    }
  });
});
