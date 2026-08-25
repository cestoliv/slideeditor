import type { DatabaseSync } from "node:sqlite";
import { text } from "../db/rows.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * The single password, in a table that holds one row by constraint rather than
 * by convention.
 */
export class CredentialStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  hasPassword(): boolean {
    return this.#stored() !== null;
  }

  /**
   * SLIDE_STUDIO_PASSWORD seeds rather than overrides, so changing the password
   * in the UI is not undone on the next restart by a stale environment.
   */
  seed(password: string): boolean {
    if (this.hasPassword()) return false;
    this.setPassword(password);
    return true;
  }

  setPassword(password: string): void {
    this.#db
      .prepare(
        `INSERT INTO auth_credential (id, password_hash, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash,
                                        updated_at = excluded.updated_at`,
      )
      .run(hashPassword(password), Date.now());
  }

  verify(password: string): boolean {
    const stored = this.#stored();
    return stored === null ? false : verifyPassword(password, stored);
  }

  #stored(): string | null {
    const row = this.#db.prepare("SELECT password_hash FROM auth_credential").get();
    return row ? text(row, "password_hash") : null;
  }
}
