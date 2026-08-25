import type { DataPaths } from "../db/open.js";

/*
 * Layout changes to the data directory, in order. The index carries no meaning
 * here, unlike the database migrations: `version` is the number recorded, so an
 * entry can never drift from the row it writes.
 *
 * Each `run` must be idempotent. The runner cannot roll a directory back, which
 * is exactly why it archives media/ before the first pending entry. A migration
 * interrupted halfway is retried on the next startup, from whatever state the
 * interruption left behind.
 *
 * This ships empty on purpose. The framework, its tests and its backup path are
 * the deliverable; the first entry arrives with the first real layout change.
 */
export interface FsMigration {
  version: number;
  describe: string;
  run(paths: DataPaths): Promise<void>;
}

export const FS_MIGRATIONS: FsMigration[] = [];
