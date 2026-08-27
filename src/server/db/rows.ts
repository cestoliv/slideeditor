import type { SQLOutputValue } from "node:sqlite";
import { HttpError } from "../errors.js";

/** One row as node:sqlite hands it back, before a service gives it a shape. */
export type Row = Record<string, SQLOutputValue>;

/**
 * The columns below all sit in STRICT tables, so SQLite has already rejected
 * anything of the wrong type. These readers exist to turn that guarantee into
 * a type rather than to repair data, which is why they fall back quietly.
 */
export function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

/**
 * Like `text()`, but for a column whose NOT NULL is enforced by the service
 * layer rather than by SQL — `project.account_id` and
 * `library_item.account_id` are SQL-nullable only because SQLite refuses
 * `ADD COLUMN ... REFERENCES` with a non-NULL default (see migrations.ts's
 * own comment on the column); every write path is what actually guarantees
 * a real value.
 *
 * `text()`'s quiet fallback is wrong for a column like this: it turns NULL —
 * a write-side guarantee broken by some path the services do not own — into
 * `""`, an empty string indistinguishable from a real (if strange) account
 * id, which then passes `z.string()` and every scope check downstream
 * without complaint. That silence is what let a NULL account cascade into
 * `assertOwnScope` reading every library item as foreign (an unrecoverable
 * save loop) and the cache and its query layer disagreeing about what "no
 * account" even means. Thrown instead, so a row like this fails loudly the
 * moment it is read rather than three layers downstream.
 */
export function requiredText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === "string" && value !== "") return value;
  throw new HttpError(
    500,
    `The database has a corrupt row: column "${column}" is required but was ${value === null ? "NULL" : "empty"}.`,
  );
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  // COUNT and SUM can hand back a bigint on a column SQLite widened.
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/** For the aggregate columns of a LEFT JOIN, where no match means NULL. */
export function optionalInteger(row: Row, column: string): number | null {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/**
 * For a nullable REAL column (font.advance) — never widened to bigint the
 * way an INTEGER aggregate can be, so this is `optionalInteger` without that
 * branch, kept as its own name rather than reused so a reader at a call site
 * knows which kind of column it is looking at.
 */
export function optionalNumber(row: Row, column: string): number | null {
  const value = row[column];
  return typeof value === "number" ? value : null;
}
