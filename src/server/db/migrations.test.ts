import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dataPaths, openDb } from "./open.js";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-migrate-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("creates the auth tables and lands on the current version", () => {
  const db = openDb(dataPaths(directory).database);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row["name"]);
  expect(names).toEqual(
    expect.arrayContaining(["auth_credential", "auth_session", "auth_token"]),
  );
  expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(5);
  db.close();
});

it("holds one credential row at most", () => {
  const db = openDb(dataPaths(directory).database);
  db.prepare("INSERT INTO auth_credential VALUES (1, 'a', 0)").run();
  expect(() =>
    db.prepare("INSERT INTO auth_credential VALUES (2, 'b', 0)").run(),
  ).toThrow();
  db.close();
});

it("adopts an existing token file as a token named legacy", () => {
  const paths = dataPaths(directory);
  writeFileSync(paths.token, "old-ambient-secret\n");
  const db = openDb(paths.database, paths.token);
  const row = db.prepare("SELECT name, prefix FROM auth_token").get();
  expect(row?.["name"]).toBe("legacy");
  expect(row?.["prefix"]).toBe("old-ambi");
  db.close();
});

it("seeds nothing when there is no token file", () => {
  const paths = dataPaths(directory);
  const db = openDb(paths.database, paths.token);
  expect(db.prepare("SELECT COUNT(*) AS n FROM auth_token").get()?.["n"]).toBe(0);
  db.close();
});

it("adopts the legacy token when an existing install upgrades", () => {
  // The case that matters in production, and the one every other test here
  // misses by starting from an empty directory. A server on the previous
  // release sits at user_version 3 with no auth_token table.
  const paths = dataPaths(directory);
  writeFileSync(paths.token, "old-ambient-secret\n");
  const before = openDb(paths.database);
  before.exec("PRAGMA user_version = 3");
  before.exec("DROP TABLE auth_token");
  before.exec("DROP TABLE auth_session");
  before.exec("DROP TABLE auth_credential");
  // fs_migration is created by the migration after this one, so a database
  // genuinely at version 3 never had it either.
  before.exec("DROP TABLE fs_migration");
  before.close();

  const after = openDb(paths.database, paths.token);
  expect(after.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(5);
  expect(after.prepare("SELECT name FROM auth_token").get()?.["name"]).toBe("legacy");
  after.close();
});

it("does not resurrect a revoked legacy token on the next startup", () => {
  const paths = dataPaths(directory);
  writeFileSync(paths.token, "old-ambient-secret\n");
  const first = openDb(paths.database, paths.token);
  first.prepare("DELETE FROM auth_token").run();
  first.close();

  const second = openDb(paths.database, paths.token);
  expect(second.prepare("SELECT COUNT(*) AS n FROM auth_token").get()?.["n"]).toBe(0);
  second.close();
});

it("backs up before applying a migration, and not when there is nothing to apply", () => {
  const paths = dataPaths(directory);
  const first = openDb(paths.database, paths.token);
  first.close();
  // A fresh database had migrations to apply, so it was backed up from v0.
  const after = readdirSync(join(directory, "backups", "db"));
  expect(after).toHaveLength(1);
  expect(after[0]).toMatch(/^slide-studio-v0-/);

  const second = openDb(paths.database, paths.token);
  second.close();
  // Nothing pending the second time, so an ordinary restart writes nothing.
  expect(readdirSync(join(directory, "backups", "db"))).toHaveLength(1);
});
