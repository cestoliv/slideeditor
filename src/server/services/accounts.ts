import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  accountDefaultsSchema,
  BUILTIN_DEFAULTS,
  type Account,
  type AccountDefaults,
} from "../../shared/schema/index.js";
import { integer, text, type Row } from "../db/rows.js";
import { HttpError } from "../errors.js";

/** Thrown by remove() when the account still owns rows. Task 8's handler (this
 * task, in app.ts) maps it to 409, naming what remains. */
export class AccountNotEmptyError extends Error {
  readonly projects: number;
  readonly items: number;

  constructor(projects: number, items: number) {
    super(
      `This account still owns ${projects} slideshow${projects === 1 ? "" : "s"} and ${items} library item${items === 1 ? "" : "s"}.`,
    );
    this.name = "AccountNotEmptyError";
    this.projects = projects;
    this.items = items;
  }
}

export interface AccountCreateInput {
  name: unknown;
  defaults: unknown;
}

export interface AccountUpdateInput {
  name?: unknown;
  defaults?: unknown;
}

export class AccountService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): Account[] {
    const rows = this.db.prepare("SELECT * FROM account ORDER BY name").all();
    return rows.map(toAccount);
  }

  get(id: string): Account | null {
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get(id);
    return row ? toAccount(row) : null;
  }

  require(id: string): Account {
    const account = this.get(id);
    if (!account) throw new HttpError(404, `No account with id ${id}`);
    return account;
  }

  create({ name, defaults }: AccountCreateInput): Account {
    const now = Date.now();
    const id = randomUUID();
    const body = normalizeDefaults(withFallback(defaults, BUILTIN_DEFAULTS));
    this.assertKnownFont(body.text.fontFamily);
    this.db
      .prepare(
        `INSERT INTO account (id, name, defaults, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, cleanName(name), JSON.stringify(body), now, now);
    return this.require(id);
  }

  update(id: string, { name, defaults }: AccountUpdateInput): Account {
    const current = this.require(id);
    const nextName = name === undefined ? current.name : cleanName(name);
    // A partial blob — `{text:{size:50}}` with no `ratio` — merges over the
    // account's own current defaults, the same way create() merges an
    // omitted field over BUILTIN_DEFAULTS (withFallback, below). Without
    // this, a caller that only meant to touch one field had to resend the
    // whole blob back or get a bare "Malformed account defaults." naming no
    // field, for an omission create() already accepts.
    const nextDefaults =
      defaults === undefined
        ? current.defaults
        : normalizeDefaults(withFallback(defaults, current.defaults));
    if (defaults !== undefined) this.assertKnownFont(nextDefaults.text.fontFamily);
    this.db
      .prepare(`UPDATE account SET name = ?, defaults = ?, updated_at = ? WHERE id = ?`)
      .run(nextName, JSON.stringify(nextDefaults), Date.now(), id);
    return this.require(id);
  }

  /**
   * Finding 13: fontFamily's other natural check, that accountDefaultsSchema
   * itself cannot make (it is shared code with no database to check
   * against) — the family has to be a row this installation's font table
   * actually knows about, or every slide painted with it silently falls back
   * to no declared face at all, with nothing telling anyone. Checked here,
   * against the real table, rather than duplicating FontService's own
   * BUILTIN_FONTS list — the two would drift the moment either changes.
   */
  private assertKnownFont(family: string): void {
    const row = this.db.prepare("SELECT 1 FROM font WHERE family = ?").get(family);
    if (!row) throw new HttpError(400, `No such font: ${family}`);
  }

  /**
   * Refuses a non-empty account rather than orphaning or cascading its rows,
   * and refuses the last account outright: every write path (slideshows,
   * library items, every MCP tool) requires one to exist, and the admin UI's
   * own "disable the control at one" was, by its own comment, only a UI
   * courtesy — a bearer token or a direct API call had nothing stopping it.
   */
  remove(id: string): void {
    this.require(id);
    const total = this.db.prepare("SELECT COUNT(*) AS total FROM account").get();
    if (!total || integer(total, "total") <= 1) {
      throw new HttpError(409, "The last account cannot be deleted.");
    }
    const projectRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM project WHERE account_id = ?")
      .get(id);
    const itemRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM library_item WHERE account_id = ?")
      .get(id);
    const projects = projectRow ? integer(projectRow, "total") : 0;
    const items = itemRow ? integer(itemRow, "total") : 0;
    if (projects || items) throw new AccountNotEmptyError(projects, items);
    this.db.prepare("DELETE FROM account WHERE id = ?").run(id);
  }
}

/**
 * Resolves a raw `accountId` field to a real account id, or throws the same
 * pair of 400s every owner of an account-scoped row needs: one for a missing
 * id, one for an id naming no account. LibraryService and ProjectService
 * each carried their own copy of this — identical apart from which noun
 * "needs an accountId" — so it lives here once instead.
 *
 * `accounts` is nullable because a unit test can construct either service
 * without one (see ProjectService.assertOwnScope's own note on the same
 * pattern); when it is null, existence is not checked, matching how the rest
 * of both services already treat a null AccountService.
 */
export function requireAccountId(
  accounts: AccountService | null,
  accountId: unknown,
  ownerLabel: string,
): string {
  const id = typeof accountId === "string" ? accountId : "";
  if (!id) throw new HttpError(400, `${ownerLabel} needs an accountId.`);
  if (accounts && !accounts.get(id)) {
    throw new HttpError(400, `Unknown account: ${id}`);
  }
  return id;
}

function cleanName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new HttpError(400, "An account needs a name.");
  return name.slice(0, 200);
}

function normalizeDefaults(value: unknown): AccountDefaults {
  const result = accountDefaultsSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Malformed account defaults.");
  return result.data;
}

/**
 * Fallback for whatever the caller's `defaults` blob leaves out — `ratio`
 * entirely, `text` entirely, or `defaults` itself. Both top-level keys are
 * required by accountDefaultsSchema with no `.catch()` of their own (unlike
 * most of `text`'s individual fields), so an incomplete blob used to fail
 * schema validation outright with a bare "Malformed account defaults." —
 * 400ing a request that named no impossible value, just an omitted one.
 *
 * `base` supplies whatever the blob omits: BUILTIN_DEFAULTS for create()
 * (which has no existing row to fall back to), the account's own current
 * defaults for update() (so a partial blob merges over what the account
 * already has, rather than resetting untouched fields to the builtins).
 *
 * Only fills what is missing at the object level — a `ratio` or `text` that
 * is present but names an actually-invalid leaf value (an out-of-range
 * text.size, say) is left untouched here and still rejected by
 * accountDefaultsSchema's own per-field validation, same as it always was.
 */
function withFallback(value: unknown, base: AccountDefaults): unknown {
  const source = asPlainObject(value);
  const ratio = asPlainObject(source?.["ratio"]);
  const text = asPlainObject(source?.["text"]);
  return {
    ratio: ratio ? { ...base.ratio, ...ratio } : base.ratio,
    text: text ? { ...base.text, ...text } : base.text,
  };
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toAccount(row: Row): Account {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    defaults: parseStoredDefaults(text(row, "defaults")),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

/**
 * A row a `create`/`update` wrote is always schema-valid, since both
 * normalise first — but a row could still be corrupted by hand (or by a
 * future migration bug), and `list()` is the screen an operator would use to
 * find and fix it. So this falls back to BUILTIN_DEFAULTS rather than
 * throwing out of `list()`/`get()` and taking every other account down with
 * it.
 */
function parseStoredDefaults(raw: string): AccountDefaults {
  const result = accountDefaultsSchema.safeParse(parseJson(raw));
  return result.success ? result.data : BUILTIN_DEFAULTS;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
