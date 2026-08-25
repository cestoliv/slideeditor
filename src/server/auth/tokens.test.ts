import { afterEach, beforeEach, expect, it } from "vitest";
import { asHttpError, catchError, createTestApp, type TestApp } from "../testing.js";
import { TokenStore } from "./tokens.js";

let app: TestApp;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  app = createTestApp();
  clock = 1_000_000;
});
afterEach(() => app.close());

it("resolves the token it minted and reports it in a list", () => {
  const store = new TokenStore(app.db, now);
  const { token, secret } = store.create("laptop");
  expect(secret.startsWith("sst_")).toBe(true);
  expect(store.resolve(secret)?.id).toBe(token.id);
  expect(store.list().map((entry) => entry.name)).toEqual(["laptop"]);
});

it("never stores the secret", () => {
  const store = new TokenStore(app.db, now);
  const { secret } = store.create("laptop");
  const row = app.db.prepare("SELECT hash, prefix FROM auth_token").get();
  expect(row?.["hash"]).not.toBe(secret);
  expect(row?.["prefix"]).toBe(secret.slice(0, 8));
});

it("records when a token was last used", () => {
  const store = new TokenStore(app.db, now);
  const { secret } = store.create("laptop");
  expect(store.list()[0]?.lastUsedAt).toBeNull();
  clock += 5000;
  store.resolve(secret);
  expect(store.list()[0]?.lastUsedAt).toBe(clock);
});

it("refuses an expired token", () => {
  const store = new TokenStore(app.db, now);
  const { secret } = store.create("temporary", clock + 1000);
  expect(store.resolve(secret)).not.toBeNull();
  const usedAt = store.list()[0]?.lastUsedAt;
  clock += 2000;
  expect(store.resolve(secret)).toBeNull();
  // The rejected call must not touch last_used_at, or a caller could tell an
  // expired token was recently presented even though resolve() refused it.
  expect(store.list()[0]?.lastUsedAt).toBe(usedAt);
});

it("refuses an unknown secret and a blank one", () => {
  const store = new TokenStore(app.db, now);
  expect(store.resolve("sst_nope")).toBeNull();
  expect(store.resolve("")).toBeNull();
});

it("revokes by id and reports an unknown id", () => {
  const store = new TokenStore(app.db, now);
  const { token, secret } = store.create("laptop");
  expect(store.revoke(token.id)).toBe(true);
  expect(store.resolve(secret)).toBeNull();
  expect(store.revoke(token.id)).toBe(false);
});

it("needs a name", async () => {
  const store = new TokenStore(app.db, now);
  expect(asHttpError(await catchError(() => store.create("  "))).status).toBe(400);
});
