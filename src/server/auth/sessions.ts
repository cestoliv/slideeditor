import type { DatabaseSync } from "node:sqlite";
import { integer, text } from "../db/rows.js";
import { hashSecret, newSessionId } from "./secrets.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A session is renewed at most once a day. Renewing on every request would put
 * a write in front of every read for no security gain.
 */
export const SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(context: { userAgent?: string; ip?: string }): string {
    const secret = newSessionId();
    const at = this.#now();
    this.#db
      .prepare(
        `INSERT INTO auth_session (id, created_at, last_seen_at, expires_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashSecret(secret),
        at,
        at,
        at + SESSION_TTL_MS,
        context.userAgent ?? "",
        context.ip ?? "",
      );
    return secret;
  }

  resolve(secret: string): SessionRecord | null {
    if (!secret) return null;
    const id = hashSecret(secret);
    const row = this.#db
      .prepare(
        "SELECT id, created_at, last_seen_at, expires_at FROM auth_session WHERE id = ?",
      )
      .get(id);
    if (!row) return null;
    const at = this.#now();
    const expiresAt = integer(row, "expires_at");
    if (expiresAt <= at) return null;

    const lastSeenAt = integer(row, "last_seen_at");
    if (at - lastSeenAt < SESSION_TOUCH_MS) {
      return {
        id: text(row, "id"),
        createdAt: integer(row, "created_at"),
        lastSeenAt,
        expiresAt,
      };
    }
    const renewed = at + SESSION_TTL_MS;
    this.#db
      .prepare("UPDATE auth_session SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .run(at, renewed, id);
    return {
      id: text(row, "id"),
      createdAt: integer(row, "created_at"),
      lastSeenAt: at,
      expiresAt: renewed,
    };
  }

  revoke(secret: string): void {
    this.#db.prepare("DELETE FROM auth_session WHERE id = ?").run(hashSecret(secret));
  }

  revokeAll(): void {
    this.#db.prepare("DELETE FROM auth_session").run();
  }

  /** A password change ends every other browser, which is the point of it. */
  revokeOthers(secret: string): void {
    this.#db.prepare("DELETE FROM auth_session WHERE id != ?").run(hashSecret(secret));
  }

  purgeExpired(): number {
    const result = this.#db
      .prepare("DELETE FROM auth_session WHERE expires_at <= ?")
      .run(this.#now());
    return Number(result.changes);
  }
}
