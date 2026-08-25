import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { integer, optionalInteger, text } from "../db/rows.js";
import type { Row } from "../db/rows.js";
import { HttpError } from "../errors.js";
import { hashSecret, newTokenSecret, tokenPrefix } from "./secrets.js";

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

const COLUMNS = "id, name, prefix, created_at, last_used_at, expires_at";

/**
 * The credential an agent holds. Long lived by design: it lives in a client
 * configuration file, and a token that expired without warning would look like
 * the server going down.
 */
export class TokenStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(
    name: string,
    expiresAt: number | null = null,
  ): { token: TokenSummary; secret: string } {
    const trimmed = name.trim();
    if (!trimmed) throw new HttpError(400, "A token needs a name.");
    const secret = newTokenSecret();
    const id = randomUUID();
    const createdAt = this.#now();
    this.#db
      .prepare(
        `INSERT INTO auth_token (id, name, hash, prefix, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, trimmed, hashSecret(secret), tokenPrefix(secret), createdAt, expiresAt);
    return {
      token: {
        id,
        name: trimmed,
        prefix: tokenPrefix(secret),
        createdAt,
        lastUsedAt: null,
        expiresAt,
      },
      secret,
    };
  }

  resolve(secret: string): TokenSummary | null {
    if (!secret) return null;
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM auth_token WHERE hash = ?`)
      .get(hashSecret(secret));
    if (!row) return null;
    const summary = toSummary(row);
    const at = this.#now();
    if (summary.expiresAt !== null && summary.expiresAt <= at) return null;
    this.#db
      .prepare("UPDATE auth_token SET last_used_at = ? WHERE id = ?")
      .run(at, summary.id);
    return { ...summary, lastUsedAt: at };
  }

  list(): TokenSummary[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM auth_token ORDER BY created_at DESC`)
      .all()
      .map(toSummary);
  }

  revoke(id: string): boolean {
    return (
      Number(this.#db.prepare("DELETE FROM auth_token WHERE id = ?").run(id).changes) > 0
    );
  }
}

function toSummary(row: Row): TokenSummary {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    prefix: text(row, "prefix"),
    createdAt: integer(row, "created_at"),
    lastUsedAt: optionalInteger(row, "last_used_at"),
    expiresAt: optionalInteger(row, "expires_at"),
  };
}
