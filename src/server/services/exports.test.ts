import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { asHttpError, catchError } from "../testing.js";
import { dataPaths, openDb } from "../db/open.js";
import { EXPORT_TTL_MS, ExportService } from "./exports.js";

/**
 * A fake mediaId shaped like a real one (MediaStore.put hashes the bytes to a
 * 64 character sha256 hex digest), so putRender's format guard accepts it
 * while these tests still get a distinct, deterministic id per label.
 */
function hashId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

let directory = "";
let db: DatabaseSync;
let clock = 1_000_000;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-exports-"));
  db = openDb(dataPaths(directory).database);
  clock = 1_000_000;
  // slideshow_render.slideshow_id and slideshow_export.slideshow_id both
  // reference project(id), and openDb turns foreign keys on, so a render needs
  // a slideshow that exists.
  for (const id of ["p1", "other"]) addProject(id);
});

function addProject(id: string): void {
  db.prepare(
    `INSERT INTO project (id, name, document, version, created_at, updated_at)
     VALUES (?, 'Trip', '{"ratio":{"w":9,"h":16},"slides":[]}', 1, 0, 0)`,
  ).run(id);
}

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function service(): ExportService {
  return new ExportService(db, () => clock);
}

function fileRender(exports: ExportService, index: number, version = 1): void {
  exports.putRender("p1", version, index, {
    mediaId: hashId(`media-${String(index)}-v${String(version)}`),
    width: 1080,
    height: 1440,
    bytes: 100 + index,
  });
}

it("returns renders in slide order whatever order they were filed in", () => {
  const exports = service();
  fileRender(exports, 2);
  fileRender(exports, 0);
  fileRender(exports, 1);
  expect(exports.rendersFor("p1", 1).map((render) => render.index)).toEqual([0, 1, 2]);
});

it("overwrites a render filed twice for the same slot", () => {
  const exports = service();
  fileRender(exports, 0);
  exports.putRender("p1", 1, 0, {
    mediaId: hashId("media-new"),
    width: 1080,
    height: 1440,
    bytes: 999,
  });
  const renders = exports.rendersFor("p1", 1);
  expect(renders).toHaveLength(1);
  expect(renders[0]?.mediaId).toBe(hashId("media-new"));
  expect(renders[0]?.bytes).toBe(999);
});

it("drops an older version's renders when a newer one is filed", () => {
  const exports = service();
  fileRender(exports, 0, 1);
  fileRender(exports, 1, 1);
  fileRender(exports, 0, 2);
  expect(exports.rendersFor("p1", 1)).toEqual([]);
  expect(exports.rendersFor("p1", 2)).toHaveLength(1);
});

it("keeps another slideshow's renders when one supersedes its own", () => {
  const exports = service();
  exports.putRender("other", 1, 0, {
    mediaId: hashId("m"),
    width: 1,
    height: 1,
    bytes: 1,
  });
  fileRender(exports, 0, 1);
  fileRender(exports, 0, 2);
  expect(exports.rendersFor("other", 1)).toHaveLength(1);
});

it("mints a distinct token that expires 45 minutes out", () => {
  const exports = service();
  const first = exports.grant("p1", 1);
  const second = exports.grant("p1", 1);
  expect(first.token).not.toBe(second.token);
  expect(first.token.length).toBeGreaterThanOrEqual(32);
  expect(first.expiresAt).toBe(clock + EXPORT_TTL_MS);
});

it("resolves a token to the render at that index", () => {
  const exports = service();
  fileRender(exports, 0);
  fileRender(exports, 1);
  const { token } = exports.grant("p1", 1);
  expect(exports.resolve(token, 1)?.mediaId).toBe(hashId("media-1-v1"));
  expect(exports.resolve(token, 9)).toBeNull();
  expect(exports.resolve("not-a-token", 0)).toBeNull();
});

it("stops resolving once the grant has expired", () => {
  const exports = service();
  fileRender(exports, 0);
  const { token } = exports.grant("p1", 1);
  expect(exports.resolve(token, 0)).not.toBeNull();
  clock += EXPORT_TTL_MS + 1;
  expect(exports.resolve(token, 0)).toBeNull();
});

it("revokes every grant for a slideshow and leaves the renders alone", () => {
  const exports = service();
  fileRender(exports, 0);
  const first = exports.grant("p1", 1);
  const second = exports.grant("p1", 1);
  expect(exports.revoke("p1")).toBe(2);
  expect(exports.resolve(first.token, 0)).toBeNull();
  expect(exports.resolve(second.token, 0)).toBeNull();
  expect(exports.rendersFor("p1", 1)).toHaveLength(1);
});

it("takes its renders and grants with a deleted slideshow", () => {
  const exports = service();
  fileRender(exports, 0);
  const { token } = exports.grant("p1", 1);
  db.prepare("DELETE FROM project WHERE id = ?").run("p1");
  // The grant is a credential that needs none of its own, so it cannot outlive
  // the slideshow it publishes. ON DELETE CASCADE is what enforces that.
  expect(exports.rendersFor("p1", 1)).toEqual([]);
  expect(exports.resolve(token, 0)).toBeNull();
});

it("resolves a grant against the version it was minted for", () => {
  const exports = service();
  fileRender(exports, 0, 1);
  const stale = exports.grant("p1", 1);
  fileRender(exports, 0, 2);
  // Version 1's rows are gone, so the grant that named it resolves to nothing.
  expect(exports.resolve(stale.token, 0)).toBeNull();
});

it("resolves a token to its own slideshow's render, not another slideshow's render at the same index and version", () => {
  const exports = service();
  exports.putRender("other", 1, 0, {
    mediaId: hashId("other-media"),
    width: 1,
    height: 1,
    bytes: 1,
  });
  fileRender(exports, 0, 1);
  // Both directions, because a join that forgets to pin slideshow_id returns
  // the same row to both tokens. Which row that is depends on SQLite's
  // iteration order, which no rule fixes, so asserting one direction alone
  // would catch the bug only on the runs where the order happens to help.
  expect(exports.resolve(exports.grant("p1", 1).token, 0)?.mediaId).toBe(
    hashId("media-0-v1"),
  );
  expect(exports.resolve(exports.grant("other", 1).token, 0)?.mediaId).toBe(
    hashId("other-media"),
  );
});

it("revoking one slideshow's grants leaves another slideshow's grant resolvable", () => {
  const exports = service();
  fileRender(exports, 0);
  exports.putRender("other", 1, 0, {
    mediaId: hashId("other-media"),
    width: 1,
    height: 1,
    bytes: 1,
  });
  const forP1 = exports.grant("p1", 1);
  const forOther = exports.grant("other", 1);
  expect(exports.revoke("p1")).toBe(1);
  expect(exports.resolve(forP1.token, 0)).toBeNull();
  expect(exports.resolve(forOther.token, 0)?.mediaId).toBe(hashId("other-media"));
});

it("rejects a media id that is not a sha256 hex digest", async () => {
  const exports = service();
  const error = asHttpError(
    await catchError(() =>
      exports.putRender("p1", 1, 0, {
        mediaId: "../../etc/passwd",
        width: 1,
        height: 1,
        bytes: 1,
      }),
    ),
  );
  expect(error.status).toBe(500);
});
