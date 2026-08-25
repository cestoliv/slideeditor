import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hashSecret, tokenPrefix } from "../auth/secrets.js";
import { runFsMigrations } from "../fs/run.js";
import { backupDatabase } from "./backup.js";
import { MIGRATIONS } from "./migrations.js";

export interface DataPaths {
  root: string;
  database: string;
  media: string;
  token: string;
}

/**
 * The user_version a database reaches once `auth_token` exists. The comparison
 * against it is `<`, and `migrate` reports the version it FOUND, so every
 * database that did not already have the table seeds exactly once.
 *
 * Getting this off by one is easy and quiet. The array index of the auth
 * migration is 3, but applying it sets user_version to 4, so a server running
 * the previous release sits at 3 with no `auth_token` table. A constant of 3
 * would make `3 < 3` false and skip seeding on the single upgrade path this
 * whole mechanism exists for, while every from-scratch test still passed.
 */
const AUTH_TABLES_VERSION = 4;

/** Ported from server/db.mjs:93-102. */
export function openDb(databasePath: string, legacyTokenPath?: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const before = userVersion(db);
  // Before the first statement of the first pending migration, and using the
  // version already read rather than reading it again, so the backup and the
  // migration cannot disagree about what version they saw. A restart with
  // nothing to apply writes nothing, so this costs an ordinary boot nothing.
  if (before < MIGRATIONS.length) backupDatabase(db, dirname(databasePath), before);
  migrate(db, before);
  // Only on the upgrade itself. Seeding on every startup would undo a
  // revocation the moment the server restarts.
  //
  // This sits outside the migration transaction on purpose (adoptLegacyToken
  // is a plain INSERT, not part of migrate's BEGIN/COMMIT), so a crash
  // between the two loses the adoption rather than leaving a torn row.
  if (legacyTokenPath && before < AUTH_TABLES_VERSION) {
    adoptLegacyToken(db, legacyTokenPath);
  }
  return db;
}

/**
 * The whole data directory, ready to serve: database migrated, layout migrated,
 * both backed up first. Separate from openDb because filesystem migrations are
 * async and openDb is called from synchronous constructors.
 */
export async function openData(
  dataDir: string,
): Promise<{ db: DatabaseSync; paths: DataPaths }> {
  const paths = dataPaths(dataDir);
  const db = openDb(paths.database, paths.token);
  await runFsMigrations(db, paths);
  return { db, paths };
}

function migrate(db: DatabaseSync, applied: number): void {
  for (const [version, sql] of MIGRATIONS.entries()) {
    if (version < applied) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      // PRAGMA does not accept bound parameters.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * The ambient shared token becomes an ordinary token row, so a script already
 * sending it keeps working after the guard stops accepting ambient credentials.
 * The file stays on disk: a rollback to the previous release has to find it.
 */
function adoptLegacyToken(db: DatabaseSync, tokenPath: string): void {
  if (!existsSync(tokenPath)) return;
  const secret = readFileSync(tokenPath, "utf8").trim();
  if (!secret) return;
  db.prepare(
    `INSERT OR IGNORE INTO auth_token (id, name, hash, prefix, created_at)
     VALUES (?, 'legacy', ?, ?, ?)`,
  ).run(randomUUID(), hashSecret(secret), tokenPrefix(secret), Date.now());
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : 0;
}

/** Ported from server/db.mjs:120-122. */
export function dataPaths(root: string): DataPaths {
  return {
    root,
    database: join(root, "slide-studio.db"),
    media: join(root, "media"),
    token: join(root, "token"),
  };
}
