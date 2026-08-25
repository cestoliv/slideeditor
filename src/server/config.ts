/*
 * Every environment variable this server reads at runtime, in one place. The
 * auth work learned this the hard way: an option threaded through three layers
 * and read by no production caller passes every unit test and fails completely
 * on a real boot.
 */

const DEFAULT_KEEP = 5;

/** How many backups to retain per kind. Zero keeps every one. */
export function backupKeep(): number {
  const raw = process.env["SLIDE_STUDIO_BACKUP_KEEP"];
  if (raw === undefined) return DEFAULT_KEEP;
  const keep = Number(raw);
  // Unreadable falls back rather than stopping a server a script started, which
  // is how cli.ts already treats SLIDE_STUDIO_PORT.
  return Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_KEEP;
}

export function backupsSkipped(): boolean {
  return Boolean(process.env["SLIDE_STUDIO_SKIP_BACKUP"]);
}
