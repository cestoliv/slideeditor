import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { backupKeep, backupsSkipped } from "../config.js";
import { pruneBackups } from "../fs/archive.js";

export function backupDatabase(
  db: DatabaseSync,
  dataDir: string,
  fromVersion: number,
): string | null {
  if (backupsSkipped()) {
    console.warn("SLIDE_STUDIO_SKIP_BACKUP is set: migrating without a database backup.");
    return null;
  }
  const directory = join(dataDir, "backups", "db");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `slide-studio-v${fromVersion}-${stamp()}.db`);

  // VACUUM INTO rather than a file copy: under WAL the main file can be missing
  // committed transactions that live in the -wal sidecar, so a copy of it alone
  // restores to a database that silently lost writes.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  // Only after a successful write. Pruning first could delete the last good
  // snapshot and then fail to produce a new one.
  pruneBackups(directory, backupKeep());
  return path;
}

/** Colons are legal in a path but awkward everywhere else. */
function stamp(): string {
  return new Date().toISOString().replace(/:/g, "-");
}
