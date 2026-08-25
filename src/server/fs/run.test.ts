import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dataPaths, openDb } from "../db/open.js";
import { fsVersion, runFsMigrations } from "./run.js";
import type { FsMigration } from "./migrations.js";
import { FS_MIGRATIONS } from "./migrations.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slide-studio-fsmig-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (version: number, file: string): FsMigration => ({
  version,
  describe: `writes ${file}`,
  run: async (paths) => {
    mkdirSync(paths.media, { recursive: true });
    writeFileSync(join(paths.media, file), "x");
  },
});

it("ships no migrations, so an ordinary upgrade does nothing", () => {
  // The framework is the deliverable. An entry arrives with the first real
  // layout change.
  expect(FS_MIGRATIONS).toEqual([]);
});

it("applies pending migrations in version order and records each", async () => {
  const paths = dataPaths(root);
  const db = openDb(paths.database, paths.token);
  const applied = await runFsMigrations(db, paths, [touch(2, "b"), touch(1, "a")]);
  expect(applied).toEqual([1, 2]);
  expect(fsVersion(db)).toBe(2);
  db.close();
});

it("does not re-run a migration it already applied", async () => {
  const paths = dataPaths(root);
  const db = openDb(paths.database, paths.token);
  let runs = 0;
  const counted: FsMigration = {
    version: 1,
    describe: "counts",
    run: async () => {
      runs += 1;
    },
  };
  await runFsMigrations(db, paths, [counted]);
  await runFsMigrations(db, paths, [counted]);
  expect(runs).toBe(1);
  db.close();
});

it("retries a migration that threw, rather than recording it", async () => {
  const paths = dataPaths(root);
  const db = openDb(paths.database, paths.token);
  let attempts = 0;
  const flaky: FsMigration = {
    version: 1,
    describe: "fails once",
    run: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    },
  };
  await expect(runFsMigrations(db, paths, [flaky])).rejects.toThrow("disk full");
  expect(fsVersion(db)).toBe(0);
  await runFsMigrations(db, paths, [flaky]);
  expect(attempts).toBe(2);
  expect(fsVersion(db)).toBe(1);
  db.close();
});

it("archives media before the first migration and not when there is nothing to do", async () => {
  const paths = dataPaths(root);
  const db = openDb(paths.database, paths.token);
  mkdirSync(paths.media, { recursive: true });
  writeFileSync(join(paths.media, "keep.png"), "png");

  await runFsMigrations(db, paths, [touch(1, "a")]);
  expect(existsSync(join(root, "backups", "fs"))).toBe(true);

  rmSync(join(root, "backups", "fs"), { recursive: true, force: true });
  // Nothing pending, so nothing is archived and an ordinary restart is free.
  await runFsMigrations(db, paths, [touch(1, "a")]);
  expect(existsSync(join(root, "backups", "fs"))).toBe(false);
  db.close();
});

it("stops before migrating when the archive cannot be written", async () => {
  const paths = dataPaths(root);
  const db = openDb(paths.database, paths.token);
  mkdirSync(paths.media, { recursive: true });
  // A file where the fs archive directory must go, so mkdir fails. `backups`
  // itself already exists here: openDb's own database backup just created it.
  writeFileSync(join(root, "backups", "fs"), "not a directory");
  await expect(runFsMigrations(db, paths, [touch(1, "a")])).rejects.toThrow();
  // A migration that cannot be undone must not run.
  expect(fsVersion(db)).toBe(0);
  db.close();
});
