import type { Project, SlideDocument } from "@shared/schema/index.js";

/** app.js:34. */
export const HISTORY_LIMIT = 200;

/**
 * What one undo entry holds.
 *
 * app.js snapshots the whole project (cloneProject, app.js:139-148) and puts
 * the whole thing back (app.js:164), so an undo also restores the version,
 * name, status and updatedAt that were current when the entry was recorded.
 * Nothing that changes those calls recordHistory: renaming (app.js:2160) and
 * setting a status (app.js:941) both skip it, and version only ever moves in
 * putProject's reply (app.js:344). Restoring them is therefore always wrong,
 * and restoring a stale version makes the save that follows the undo take a
 * 409 and reload the very edit the user just undid. Keeping the entry to the
 * document leaves those fields on the live project.
 */
export type DocumentSnapshot = SlideDocument;

export function snapshotDocument(project: Project): DocumentSnapshot {
  return structuredClone({ ratio: project.ratio, slides: project.slides });
}

/** Puts a snapshot back on the live project, leaving the server-owned fields alone. */
export function restoreDocument(project: Project, snapshot: DocumentSnapshot): void {
  const restored = structuredClone(snapshot);
  project.ratio = restored.ratio;
  project.slides = restored.slides;
}

/**
 * The undo and redo stacks, ported from app.js:105-189. Holds snapshots of any
 * shape so it can be tested without a project.
 */
export class History<T> {
  private readonly past: T[] = [];
  private readonly future: T[] = [];

  constructor(readonly limit: number = HISTORY_LIMIT) {}

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * app.js:151-157. A fresh edit makes the recorded redo entries unreachable,
   * so they go.
   */
  record(snapshot: T): void {
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  /**
   * app.js:175-181. Answers the snapshot to restore, or null when there is
   * nothing to undo, in which case the current state is not banked either.
   */
  undo(current: T): T | null {
    if (!this.past.length) return null;
    this.future.push(current);
    return this.past.pop() ?? null;
  }

  /** app.js:183-189. The limit guards new edits only, so stepping through history never trims. */
  redo(current: T): T | null {
    if (!this.future.length) return null;
    this.past.push(current);
    return this.future.pop() ?? null;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }

  /** Stack depths, for tests and for anything that wants to show them. */
  get sizes(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }
}
