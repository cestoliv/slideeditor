import { gunzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { unpackTar } from "./tar.js";
import { archiveDirectory, pruneBackups } from "./archive.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slide-studio-archive-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("archives every file in the directory and restores them byte for byte", async () => {
  const media = join(root, "media");
  mkdirSync(media);
  writeFileSync(join(media, "a.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(media, "b.jpg"), Buffer.alloc(600, 4));

  const path = await archiveDirectory(media, join(root, "backups"), "media", { keep: 5 });
  expect(path).not.toBeNull();

  const entries = unpackTar(gunzipSync(readFileSync(path!)));
  const names = entries.map((entry) => entry.name).sort();
  expect(names).toEqual(["a.png", "b.jpg"]);
  expect(entries.find((e) => e.name === "b.jpg")?.body.equals(Buffer.alloc(600, 4))).toBe(
    true,
  );
});

it("returns null for a directory that is not there", async () => {
  expect(
    await archiveDirectory(join(root, "nope"), join(root, "b"), "media", { keep: 5 }),
  ).toBeNull();
});

it("archives an empty directory rather than skipping it", async () => {
  // An empty media directory is a real state, and a missing archive would make
  // the migration look unprotected.
  mkdirSync(join(root, "media"));
  const path = await archiveDirectory(
    join(root, "media"),
    join(root, "backups"),
    "media",
    {
      keep: 5,
    },
  );
  expect(path).not.toBeNull();
  expect(unpackTar(gunzipSync(readFileSync(path!)))).toEqual([]);
});

it("keeps only the newest archives, oldest pruned first", () => {
  const backups = join(root, "backups");
  mkdirSync(backups, { recursive: true });
  for (const name of [
    "media-1.tar.gz",
    "media-2.tar.gz",
    "media-3.tar.gz",
    "media-4.tar.gz",
  ]) {
    writeFileSync(join(backups, name), "x");
  }
  expect(pruneBackups(backups, 2)).toBe(2);
  expect(readdirSync(backups).sort()).toEqual(["media-3.tar.gz", "media-4.tar.gz"]);
});

it("keeps everything when the limit is zero", () => {
  const backups = join(root, "backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "media-1.tar.gz"), "x");
  expect(pruneBackups(backups, 0)).toBe(0);
  expect(readdirSync(backups)).toHaveLength(1);
});
