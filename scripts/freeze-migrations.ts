#!/usr/bin/env -S npx tsx
// Updates src/server/db/migrations.checksums.json to match src/server/db/
// migrations.ts, refusing to touch an entry that is already committed and no
// longer matches — that refusal is the guard: migrations.test.ts's own
// checksum test trusts that a checksum already in the file is exactly what
// shipped, so this script is the only thing that is ever supposed to write
// one, and only once, the same day the migration it covers is authored.
//
// Run this after adding a new migration to migrations.ts, before committing:
//
//   npm run migrations:freeze
//
// If it refuses because an existing entry no longer matches, you have edited
// a migration that already has a checksum committed — do not "fix" this by
// re-running with --force unless you are certain nothing has ever migrated a
// database against that entry's old text (in practice: it has not shipped in
// any release yet). The right fix is almost always a new migration that
// corrects the earlier one, appended rather than edited in place — see
// migrations.ts's own comment on the first two entries, and
// migrations.test.ts's failure message on a mismatch.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS } from "../src/server/db/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const checksumsPath = join(here, "../src/server/db/migrations.checksums.json");
const force = process.argv.includes("--force");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readExisting(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(checksumsPath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error(`${checksumsPath} does not hold a plain array of strings.`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const existing = readExisting();
const next = MIGRATIONS.map(sha256);

const mismatches: number[] = [];
for (const [index, hash] of existing.entries()) {
  if (index < next.length && next[index] !== hash) mismatches.push(index);
}

if (mismatches.length > 0 && !force) {
  console.error(
    `Refusing to overwrite the committed checksum for migration ${mismatches.join(", ")}: ` +
      "its text no longer matches what was frozen. Add a new migration instead of editing " +
      "this one — see this script's own header comment. Pass --force only if you are certain " +
      "no database has ever migrated against the old text.",
  );
  process.exit(1);
}

writeFileSync(checksumsPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(
  `Wrote ${String(next.length)} checksum${next.length === 1 ? "" : "s"} to ` +
    `${checksumsPath} (${String(next.length - existing.length)} new).`,
);
