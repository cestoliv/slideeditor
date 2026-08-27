import { afterEach, expect, it } from "vitest";
import { BUILTIN_DEFAULTS } from "../../shared/schema/index.js";
import { asHttpError, catchError, createTestApp, type TestApp } from "../testing.js";
import { AccountNotEmptyError } from "./accounts.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

it("seeds the default account with today's rendering defaults", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.require("default");
  expect(account.name).toBe("Default");
  expect(account.defaults).toEqual(BUILTIN_DEFAULTS);
});

it("creates, updates and lists accounts", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const created = accounts.create({ name: "Brand B", defaults: BUILTIN_DEFAULTS });
  expect(accounts.list().map((a) => a.id)).toEqual(
    expect.arrayContaining(["default", created.id]),
  );
  const updated = accounts.update(created.id, { name: "Brand B Renamed" });
  expect(updated.name).toBe("Brand B Renamed");
  expect(updated.defaults).toEqual(BUILTIN_DEFAULTS);
});

it("rejects reading an unknown account", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const error = asHttpError(await catchError(() => accounts.require("nope")));
  expect(error.status).toBe(404);
});

it("rejects deleting an account that still owns slideshows or library items", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Brand B", defaults: BUILTIN_DEFAULTS });
  const now = Date.now();
  // Rows inserted directly: Task 4 gives ProjectService/LibraryService their
  // own accountId parameter, which this task does not depend on.
  app.db
    .prepare(
      `INSERT INTO project (id, name, document, version, status, description, hashtags, account_id, created_at, updated_at)
       VALUES ('p1', 'P', '{"ratio":{"w":9,"h":16},"slides":[]}', 1, 'draft', '', '', ?, ?, ?)`,
    )
    .run(account.id, now, now);
  app.db
    .prepare(
      `INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, account_id, created_at, updated_at)
       VALUES ('i1', 'background', 'I', '', '', '', 'm1', 'png', 10, 10, ?, ?, ?)`,
    )
    .run(account.id, now, now);

  const error = await catchError(() => accounts.remove(account.id));
  expect(error).toBeInstanceOf(AccountNotEmptyError);
  expect((error as AccountNotEmptyError).projects).toBe(1);
  expect((error as AccountNotEmptyError).items).toBe(1);
});

it("removes an empty account", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Empty", defaults: BUILTIN_DEFAULTS });
  accounts.remove(account.id);
  expect(accounts.get(account.id)).toBeNull();
});

it("rejects deleting an account that owns only a library item", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Items Only", defaults: BUILTIN_DEFAULTS });
  const now = Date.now();
  app.db
    .prepare(
      `INSERT INTO library_item (id, kind, name, description, usage, tags, media_id, ext, width, height, account_id, created_at, updated_at)
       VALUES ('i2', 'background', 'I', '', '', '', 'm1', 'png', 10, 10, ?, ?, ?)`,
    )
    .run(account.id, now, now);

  const error = await catchError(() => accounts.remove(account.id));
  expect(error).toBeInstanceOf(AccountNotEmptyError);
  expect((error as AccountNotEmptyError).projects).toBe(0);
  expect((error as AccountNotEmptyError).items).toBe(1);
});

it("rejects deleting an account that owns only a project", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Projects Only", defaults: BUILTIN_DEFAULTS });
  const now = Date.now();
  app.db
    .prepare(
      `INSERT INTO project (id, name, document, version, status, description, hashtags, account_id, created_at, updated_at)
       VALUES ('p2', 'P', '{"ratio":{"w":9,"h":16},"slides":[]}', 1, 'draft', '', '', ?, ?, ?)`,
    )
    .run(account.id, now, now);

  const error = await catchError(() => accounts.remove(account.id));
  expect(error).toBeInstanceOf(AccountNotEmptyError);
  expect((error as AccountNotEmptyError).projects).toBe(1);
  expect((error as AccountNotEmptyError).items).toBe(0);
});

/*
 * Finding 6: create() ran normalizeDefaults() unconditionally with no
 * BUILTIN_DEFAULTS fallback, and accountDefaultsSchema's `text` object has
 * no `.catch()` of its own (unlike update(), which already falls back to
 * the account's current value when `defaults` is omitted entirely). A
 * caller that supplied `ratio` but left `text` out altogether — not
 * malformed, just absent — 400ed with an opaque "Malformed account
 * defaults." instead of getting the builtin's own text defaults the way an
 * omitted top-level `defaults` already did.
 */
it("fills in the builtin text defaults when a create() blob supplies only a ratio", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({
    name: "Bare",
    defaults: { ratio: { w: 3, h: 4 } },
  });
  expect(account.defaults).toEqual({ ...BUILTIN_DEFAULTS, ratio: { w: 3, h: 4 } });
});

/*
 * Finding 6, the other repro: `defaults` omitted entirely rather than a
 * partial object. update() already falls back correctly for this exact
 * shape (`defaults === undefined ? current.defaults : ...`); create() has no
 * "current" account to fall back to, so it falls back to BUILTIN_DEFAULTS.
 */
it("falls back to the full builtin defaults when create() receives no defaults at all", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "X", defaults: undefined });
  expect(account.defaults).toEqual(BUILTIN_DEFAULTS);
});

/*
 * update() only had the all-or-nothing fallback above (`defaults ===
 * undefined ? current.defaults : ...`) — a *partial* blob, `defaults`
 * present but missing `ratio` entirely, skipped that branch and went
 * straight to accountDefaultsSchema, which 400ed with a bare "Malformed
 * account defaults." for an omission create() already accepts. update() now
 * merges a partial blob over the account's own current defaults, the same
 * shape as create()'s merge over BUILTIN_DEFAULTS.
 */
it("merges a partial update() blob over the account's current defaults", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({
    name: "Starts square",
    defaults: { ...BUILTIN_DEFAULTS, ratio: { w: 1, h: 1 } },
  });
  const updated = accounts.update(account.id, {
    defaults: { text: { ...BUILTIN_DEFAULTS.text, size: 50 } },
  });
  expect(updated.defaults).toEqual({
    ratio: { w: 1, h: 1 },
    text: { ...BUILTIN_DEFAULTS.text, size: 50 },
  });
});

/*
 * The other half of finding 6's fix: filling in what is OMITTED must not
 * paper over what is actually INVALID. A text object that names an
 * out-of-range size (finding 1's own bounded schema) is present, not
 * missing, so it is left for accountDefaultsSchema's own validation to
 * reject rather than silently repaired by the builtin fallback.
 */
it("still rejects a create() blob whose text is present but names an invalid size", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const error = asHttpError(
    await catchError(() =>
      accounts.create({
        name: "Invalid size",
        defaults: { ratio: { w: 9, h: 16 }, text: { ...BUILTIN_DEFAULTS.text, size: 0 } },
      }),
    ),
  );
  expect(error.status).toBe(400);
});

/*
 * Finding 13: fontFamily accepted any string, with no check that this
 * installation actually knows the family — accountDefaultsSchema itself
 * cannot check the font table (it is shared code, no database access), so
 * the check runs here instead, against the real table. An unknown family
 * used to be stored verbatim and every slide painted with it fell back to
 * whatever face the browser substituted, with no error anywhere.
 */
it("rejects a create() whose text names a font this installation does not have", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const error = asHttpError(
    await catchError(() =>
      accounts.create({
        name: "Unknown font",
        defaults: {
          ratio: { w: 9, h: 16 },
          text: { ...BUILTIN_DEFAULTS.text, fontFamily: "Not A Real Font" },
        },
      }),
    ),
  );
  expect(error.status).toBe(400);
});

it("rejects an update() whose text names a font this installation does not have", async () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Real font", defaults: BUILTIN_DEFAULTS });
  const error = asHttpError(
    await catchError(() =>
      accounts.update(account.id, {
        defaults: {
          ratio: { w: 9, h: 16 },
          text: { ...BUILTIN_DEFAULTS.text, fontFamily: "Not A Real Font" },
        },
      }),
    ),
  );
  expect(error.status).toBe(400);
});

it("accepts a font actually added to the catalogue as an account's default", () => {
  app = createTestApp();
  const { accounts } = app.services;
  // FontService's own constructor already ran and seeded the builtins;
  // this row simulates a Google font someone actually added.
  app.db
    .prepare(
      `INSERT INTO font (id, family, source, weight, media_id, ext, created_at)
       VALUES ('f1', 'Bebas Neue', 'google', 400, 'm1', 'woff2', ?)`,
    )
    .run(Date.now());
  const account = accounts.create({
    name: "Uses Bebas Neue",
    defaults: {
      ratio: { w: 9, h: 16 },
      text: { ...BUILTIN_DEFAULTS.text, fontFamily: "Bebas Neue" },
    },
  });
  expect(account.defaults.text.fontFamily).toBe("Bebas Neue");
});

it("falls back to the builtin defaults when a stored defaults blob fails the schema", () => {
  app = createTestApp();
  const { accounts } = app.services;
  const account = accounts.create({ name: "Corrupt", defaults: BUILTIN_DEFAULTS });
  // Valid JSON, but missing the required `text` key — the case a JSON.parse
  // try/catch alone can't catch, since JSON.parse succeeds on it.
  app.db.prepare(`UPDATE account SET defaults = ? WHERE id = ?`).run("{}", account.id);

  const listed = accounts.list().find((a) => a.id === account.id);
  expect(listed?.defaults).toEqual(BUILTIN_DEFAULTS);
});
