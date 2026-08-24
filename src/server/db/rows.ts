import type { SQLOutputValue } from "node:sqlite";

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
