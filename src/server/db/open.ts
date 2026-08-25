import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export interface DataPaths {
  root: string;
  database: string;
  media: string;
  token: string;
}

/** Ported from server/db.mjs:93-102. */
export function openDb(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const applied = userVersion(db);
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
