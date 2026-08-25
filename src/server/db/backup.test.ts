import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backupDatabase } from "./backup.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slide-studio-backup-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["SLIDE_STUDIO_SKIP_BACKUP"];
  delete process.env["SLIDE_STUDIO_BACKUP_KEEP"];
});

function seeded(): DatabaseSync {
  const db = new DatabaseSync(join(root, "s.db"));
  db.exec("CREATE TABLE t (v TEXT) STRICT");
  db.prepare("INSERT INTO t VALUES (?)").run("before");
  db.exec("PRAGMA user_version = 3");
  return db;
}

it("writes a snapshot that opens as a database holding the old rows", () => {
  const db = seeded();
  const path = backupDatabase(db, root, 3);
  expect(path).not.toBeNull();

  // The snapshot must be a real database, not a copy of a file mid-write.
  const restored = new DatabaseSync(path!);
  expect(restored.prepare("SELECT v FROM t").get()?.["v"]).toBe("before");
  expect(restored.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(3);
  restored.close();
  db.close();
});

it("names the snapshot after the version it restores to", () => {
  const db = seeded();
  backupDatabase(db, root, 3);
  const names = readdirSync(join(root, "backups", "db"));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^slide-studio-v3-.*\.db$/);
  db.close();
});

it("keeps a snapshot taken while WAL holds uncommitted-to-main data", () => {
  const db = seeded();
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare("INSERT INTO t VALUES (?)").run("in-wal");
  // A plain file copy of s.db without its -wal sidecar would miss this row.
  const path = backupDatabase(db, root, 3);
  const restored = new DatabaseSync(path!);
  expect(restored.prepare("SELECT COUNT(*) AS n FROM t").get()?.["n"]).toBe(2);
  restored.close();
  db.close();
});

it("skips and returns null when backups are switched off", () => {
  process.env["SLIDE_STUDIO_SKIP_BACKUP"] = "1";
  const db = seeded();
  expect(backupDatabase(db, root, 3)).toBeNull();
  db.close();
});

it("prunes to the retention limit", () => {
  process.env["SLIDE_STUDIO_BACKUP_KEEP"] = "2";
  const db = seeded();
  for (let n = 0; n < 4; n += 1) backupDatabase(db, root, n);
  expect(readdirSync(join(root, "backups", "db"))).toHaveLength(2);
  db.close();
});
