import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { dataPaths, openDb } from "./open.js";
import { integer, text } from "./rows.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slide-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return row ? integer(row, "user_version") : -1;
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => text(row, "name"));
}

it("applies every migration on a fresh database", () => {
  const db = openDb(join(dir, "test.db"));
  expect(userVersion(db)).toBe(7);
  const tables = tableNames(db);
  expect(tables).toContain("item_use_history");
  expect(tables).toContain("library_item");
  expect(tables).toContain("project");
  expect(tables).toContain("project_item_use");
  expect(tables).toContain("account");
  expect(tables).toContain("font");
  db.close();
});

it("is idempotent when reopened", () => {
  openDb(join(dir, "test.db")).close();
  const db = openDb(join(dir, "test.db"));
  expect(userVersion(db)).toBe(7);
  db.close();
});

it("creates the directory the database sits in", () => {
  const nested = join(dir, "deep", "deeper");
  openDb(join(nested, "test.db")).close();
  expect(existsSync(join(nested, "test.db"))).toBe(true);
});

it("turns on WAL, foreign keys and the busy timeout", () => {
  const db = openDb(join(dir, "test.db"));
  const journal = db.prepare("PRAGMA journal_mode").get();
  const keys = db.prepare("PRAGMA foreign_keys").get();
  const timeout = db.prepare("PRAGMA busy_timeout").get();
  expect(journal && text(journal, "journal_mode")).toBe("wal");
  expect(keys && integer(keys, "foreign_keys")).toBe(1);
  expect(timeout && integer(timeout, "timeout")).toBe(5000);
  db.close();
});

it("seeds usage history from existing project use", () => {
  const file = join(dir, "existing.db");
  const now = 1_700_000_000_000;

  // A database as it stands on a user's disk before the stats migration: the
  // first migration only, with a slideshow already pointing at a library item.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(MIGRATIONS[0] ?? "");
  old.exec("PRAGMA user_version = 1");
  old
    .prepare(
      `INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, created_at, updated_at)
       VALUES (?, 'background', 'Backdrop', '', '', '', 'abc123', 'png', 1080, 1920, ?, ?)`,
    )
    .run("item-1", now, now);
  old
    .prepare(
      "INSERT INTO project (id, name, document, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(
      "project-1",
      "Existing",
      JSON.stringify({ ratio: { w: 9, h: 16 }, slides: [] }),
      now,
      now,
    );
  old
    .prepare("INSERT INTO project_item_use (project_id, item_id) VALUES (?, ?)")
    .run("project-1", "item-1");
  expect(userVersion(old)).toBe(1);
  old.close();

  const db = openDb(file);

  expect(userVersion(db), "the upgrade runs on open").toBe(7);
  const history = db.prepare("SELECT * FROM item_use_history").all();
  expect(history.length).toBe(1);
  const row = history[0] ?? {};
  expect(text(row, "item_id")).toBe("item-1");
  expect(text(row, "project_id")).toBe("project-1");
  expect(integer(row, "placements"), "one placement per existing use row").toBe(1);
  expect(integer(row, "first_used_at")).toBe(now);
  expect(integer(row, "last_used_at")).toBe(now);

  const project = db.prepare("SELECT * FROM project WHERE id = ?").get("project-1");
  expect(project && text(project, "status"), "the new column defaults to draft").toBe(
    "draft",
  );
  expect(project && text(project, "name"), "the slideshow itself is untouched").toBe(
    "Existing",
  );

  // Reopening must not seed a second time.
  db.close();
  const again = openDb(file);
  expect(
    again
      .prepare("SELECT COUNT(*) AS total FROM item_use_history")
      .all()
      .map((entry) => integer(entry, "total")),
  ).toEqual([1]);
  again.close();
});

it("adds the caption columns to a database that already holds slideshows", () => {
  const file = join(dir, "captions.db");
  const now = 1_700_000_000_000;

  // A database as it stands on a user's disk before the caption migration:
  // every migration up to the status one, with a slideshow already in it.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(MIGRATIONS[0] ?? "");
  old.exec(MIGRATIONS[1] ?? "");
  old.exec("PRAGMA user_version = 2");
  old
    .prepare(
      `INSERT INTO project (id, name, document, version, status, created_at, updated_at)
       VALUES (?, ?, ?, 7, 'ready', ?, ?)`,
    )
    .run(
      "project-1",
      "Summer travel tips",
      JSON.stringify({ ratio: { w: 4, h: 5 }, slides: [{ id: "s1" }] }),
      now,
      now,
    );
  expect(userVersion(old)).toBe(2);
  old.close();

  const db = openDb(file);

  expect(userVersion(db), "the upgrade runs on open").toBe(7);
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get("project-1") ?? {};
  expect(Object.keys(row), "the two caption columns are there to be written").toContain(
    "description",
  );
  expect(Object.keys(row)).toContain("hashtags");
  expect(text(row, "description"), "an existing slideshow carries no caption").toBe("");
  expect(text(row, "hashtags")).toBe("");

  // Nothing else moved. A slideshow whose version or document changed under an
  // upgrade would make the next save from an open editor conflict, or lose it.
  expect(text(row, "name")).toBe("Summer travel tips");
  expect(text(row, "status")).toBe("ready");
  expect(integer(row, "version")).toBe(7);
  expect(integer(row, "created_at")).toBe(now);
  expect(integer(row, "updated_at")).toBe(now);
  expect(JSON.parse(text(row, "document"))).toEqual({
    ratio: { w: 4, h: 5 },
    slides: [{ id: "s1" }],
  });

  // A caption written after the upgrade survives the next open, which is what
  // proves the columns are real rather than defaults read off a missing column.
  db.prepare("UPDATE project SET description = ?, hashtags = ? WHERE id = ?").run(
    "Booking a summer trip?",
    "#travel #summer",
    "project-1",
  );
  db.close();

  const again = openDb(file);
  const stored =
    again.prepare("SELECT * FROM project WHERE id = ?").get("project-1") ?? {};
  expect(text(stored, "description")).toBe("Booking a summer trip?");
  expect(text(stored, "hashtags")).toBe("#travel #summer");
  again.close();
});

it("creates the default account and backfills existing rows on upgrade", () => {
  const file = join(dir, "accounts.db");
  const now = 1_700_000_000_000;

  // A database as it stands before the accounts migration: every migration up
  // to the caption one, with a slideshow and a library item already in it.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(MIGRATIONS[0] ?? "");
  old.exec(MIGRATIONS[1] ?? "");
  old.exec(MIGRATIONS[2] ?? "");
  old.exec(MIGRATIONS[3] ?? "");
  old.exec(MIGRATIONS[4] ?? "");
  old.exec("PRAGMA user_version = 5");
  old
    .prepare(
      `INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, created_at, updated_at)
       VALUES ('item-1', 'background', 'Backdrop', '', '', '', 'abc123', 'png', 1080, 1920, ?, ?)`,
    )
    .run(now, now);
  old
    .prepare(
      `INSERT INTO project (id, name, document, version, status, description, hashtags, created_at, updated_at)
       VALUES ('project-1', 'Existing', ?, 1, 'draft', '', '', ?, ?)`,
    )
    .run(JSON.stringify({ ratio: { w: 9, h: 16 }, slides: [] }), now, now);
  expect(userVersion(old)).toBe(5);
  old.close();

  const db = openDb(file);
  expect(userVersion(db), "the upgrade runs on open").toBe(7);

  const account = db.prepare("SELECT * FROM account WHERE id = 'default'").get() ?? {};
  expect(text(account, "name")).toBe("Default");
  expect(JSON.parse(text(account, "defaults"))).toEqual({
    ratio: { w: 9, h: 16 },
    text: {
      fontFamily: "TikTok Sans",
      size: 64,
      style: "plain",
      color: "#FFFFFF",
      background: "white",
      backgroundShape: "lines",
      align: "center",
    },
  });

  const item = db.prepare("SELECT * FROM library_item WHERE id = 'item-1'").get() ?? {};
  expect(text(item, "account_id")).toBe("default");
  const project = db.prepare("SELECT * FROM project WHERE id = 'project-1'").get() ?? {};
  expect(text(project, "account_id")).toBe("default");

  db.close();
});

it("names the four paths under the data directory", () => {
  expect(dataPaths("/data/slide")).toEqual({
    root: "/data/slide",
    database: "/data/slide/slide-studio.db",
    media: "/data/slide/media",
    token: "/data/slide/token",
  });
});
