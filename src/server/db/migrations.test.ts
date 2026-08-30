import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dataPaths, openDb } from "./open.js";
import { MIGRATIONS } from "./migrations.js";

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
    expect.arrayContaining([
      "auth_credential",
      "auth_session",
      "auth_token",
      "slideshow_render",
      "slideshow_export",
    ]),
  );
  expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(7);
  db.close();
});

it("keys a render on the slideshow, the version and the index", () => {
  const db = openDb(dataPaths(directory).database);
  // openDb turns foreign keys on and slideshow_id references project(id).
  db.prepare(
    `INSERT INTO project (id, name, document, version, created_at, updated_at)
     VALUES ('p1', 'Trip', '{}', 1, 0, 0)`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO slideshow_render
       (slideshow_id, version, idx, media_id, width, height, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("p1", 1, 0, "abc", 1080, 1440, 100, 0);
  // The same slot again is a conflict; the next index is not.
  expect(() => insert.run("p1", 1, 0, "def", 1080, 1440, 100, 0)).toThrow();
  insert.run("p1", 1, 1, "def", 1080, 1440, 100, 0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM slideshow_render").get()?.["n"]).toBe(2);
  db.prepare(
    `INSERT INTO slideshow_export (token, slideshow_id, version, expires_at, created_at)
     VALUES ('t1', 'p1', 1, 9e15, 0)`,
  ).run();
  // A grant reads its renders without a credential, so deleting the slideshow
  // has to take both with it.
  db.prepare("DELETE FROM project WHERE id = 'p1'").run();
  expect(db.prepare("SELECT COUNT(*) AS n FROM slideshow_render").get()?.["n"]).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM slideshow_export").get()?.["n"]).toBe(0);
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
  // fs_migration, account/font and slideshow_render/slideshow_export are
  // created by migrations after this one, so a database genuinely at version
  // 3 never had them either. Same for the account_id columns and their
  // indexes on project/library_item.
  before.exec("DROP TABLE fs_migration");
  before.exec("DROP INDEX project_account_idx");
  before.exec("DROP INDEX library_item_account_idx");
  before.exec("ALTER TABLE project DROP COLUMN account_id");
  before.exec("ALTER TABLE library_item DROP COLUMN account_id");
  before.exec("DROP TABLE font");
  before.exec("DROP TABLE account");
  before.exec("DROP TABLE slideshow_render");
  before.exec("DROP TABLE slideshow_export");
  before.close();

  const after = openDb(paths.database, paths.token);
  expect(after.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(7);
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

// A database already on disk has run these migrations' exact SQL and recorded
// user_version past them; migrate() never reruns an applied index, so nothing
// re-verifies its text on a later boot. The in-place edit that once inserted
// weight_min/weight_max into the accounts/font migration (see the CREATE
// TABLE font comment in migrations.ts) passed every existing check and still
// broke every database created between the two commits. Hashing guards
// against a repeat: editing a migration string that has already been
// released fails here instead of failing quietly on someone else's disk.
//
// Fix round 4's finding was a hand-maintained array of checksums that "grows
// at merge" with nothing enforcing that growth. Fix round 5 derived the
// released set from git instead — everything up to the merge-base with main
// — which fixed the growth problem but broke on a shallow, ref-less
// checkout: `actions/checkout@v4` with no `fetch-depth` gives a `pull_request`
// job neither `origin/main` nor `main`, so `npm test` failed on every single
// PR (CI's own checkout, not a contrived shape). It was also a tautology on
// the `push: [main]` path, where merge-base(HEAD, origin/main) is HEAD
// itself, comparing MIGRATIONS against a copy of itself.
//
// This is the checksums file that fix round 4 tried by hand, but committed
// (migrations.checksums.json, alongside this file) and machine-written by
// scripts/freeze-migrations.ts (its own header comment has the full story),
// which is the enforcement fix: this test requires exactly one checksum per
// entry in MIGRATIONS, always, on every branch and every commit — not only
// "whatever shipped to main" — so a migration added with no matching
// checksum fails right here, on its own author's own branch, before it ever
// reaches a PR. No git command runs anywhere below.
const checksumsPath = new URL("./migrations.checksums.json", import.meta.url);

function readChecksums(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(checksumsPath, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${checksumsPath.pathname} does not hold a plain array of strings.`);
  }
  return parsed;
}

it("keeps every migration's SQL byte-identical to its committed checksum", () => {
  const checksums = readChecksums();
  expect(
    checksums.length,
    `migrations.checksums.json has ${String(checksums.length)} entries for ` +
      `MIGRATIONS' ${String(MIGRATIONS.length)}. Run \`npm run migrations:freeze\` after adding ` +
      "a migration, before committing.",
  ).toBe(MIGRATIONS.length);

  MIGRATIONS.forEach((sql, index) => {
    const expectedHash = checksums[index];
    const actualHash = createHash("sha256").update(sql).digest("hex");
    expect(
      actualHash,
      `migration ${String(index)} no longer matches its committed checksum. Fix forward ` +
        "with a new migration instead of editing this one — see " +
        "scripts/freeze-migrations.ts's own header comment.",
    ).toBe(expectedHash);
  });
});
