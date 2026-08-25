import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { integer } from "../db/rows.js";
import type { DataPaths } from "../db/open.js";
import { backupKeep, backupsSkipped } from "../config.js";
import { archiveDirectory } from "./archive.js";
import { FS_MIGRATIONS, type FsMigration } from "./migrations.js";

export function fsVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM fs_migration").get();
  return row ? integer(row, "v") : 0;
}

export async function runFsMigrations(
  db: DatabaseSync,
  paths: DataPaths,
  migrations: FsMigration[] = FS_MIGRATIONS,
): Promise<number[]> {
  const applied = fsVersion(db);
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => migration.version > applied);
  if (pending.length === 0) return [];

  // Before the first one, never per migration: the archive is a snapshot of the
  // state the whole run started from, which is what an operator restores to.
  if (!backupsSkipped()) {
    console.log(`Archiving ${paths.media} before ${pending.length} layout migration(s).`);
    await archiveDirectory(
      paths.media,
      join(paths.root, "backups", "fs"),
      `media-v${applied}`,
      {
        keep: backupKeep(),
      },
    );
  }

  const done: number[] = [];
  for (const migration of pending) {
    console.log(`Filesystem migration ${migration.version}: ${migration.describe}`);
    // The row is written only after run() resolves, so an interrupted migration
    // is retried on the next startup rather than skipped.
    await migration.run(paths);
    db.prepare("INSERT INTO fs_migration (version, applied_at) VALUES (?, ?)").run(
      migration.version,
      Date.now(),
    );
    done.push(migration.version);
  }
  return done;
}
