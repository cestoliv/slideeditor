// Backs up a directory to a gzipped tar before a filesystem-layout migration
// rewrites it, and prunes older backups afterward.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { packTar } from "./tar.js";

export interface ArchiveOptions {
  /** How many archives to keep in `intoDirectory`. 0 keeps every one. */
  keep: number;
}

/** Returns the archive path, or null when `from` does not exist. */
export async function archiveDirectory(
  from: string,
  intoDirectory: string,
  label: string,
  options: ArchiveOptions,
): Promise<string | null> {
  if (!existsSync(from)) return null;

  const entries = readdirSync(from, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      body: readFileSync(join(from, entry.name)),
    }));

  mkdirSync(intoDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const path = join(intoDirectory, `${label}-${timestamp}.tar.gz`);
  writeFileSync(path, gzipSync(packTar(entries)));

  // Prune only after a successful write: pruning first could delete the last
  // good backup and then fail to make a new one.
  pruneBackups(intoDirectory, options.keep);

  return path;
}

export function pruneBackups(directory: string, keep: number): number {
  if (keep <= 0) return 0;

  // Names carry ISO timestamps, so lexicographic name order is time order.
  const names = readdirSync(directory).sort();
  const toRemove = names.length > keep ? names.slice(0, names.length - keep) : [];
  for (const name of toRemove) unlinkSync(join(directory, name));
  return toRemove.length;
}
