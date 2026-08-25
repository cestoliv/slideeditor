import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing.js";
import { SESSION_TTL_MS, SessionStore } from "./sessions.js";

let app: TestApp;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  app = createTestApp();
  clock = 1_000_000;
});
afterEach(() => app.close());

it("resolves the session it minted", () => {
  const store = new SessionStore(app.db, now);
  const secret = store.create({ userAgent: "vitest", ip: "10.0.0.1" });
  expect(store.resolve(secret)).not.toBeNull();
  expect(store.resolve("not-a-session")).toBeNull();
});

it("stores the hash rather than the cookie value", () => {
  const store = new SessionStore(app.db, now);
  const secret = store.create({});
  const row = app.db.prepare("SELECT id FROM auth_session").get();
  expect(row?.["id"]).not.toBe(secret);
  expect(String(row?.["id"])).toMatch(/^[0-9a-f]{64}$/);
});

it("stops resolving once the session expires", () => {
  const store = new SessionStore(app.db, now);
  const secret = store.create({});
  clock += SESSION_TTL_MS + 1;
  expect(store.resolve(secret)).toBeNull();
});

it("slides the expiry when a session is used after a day", () => {
  const store = new SessionStore(app.db, now);
  const secret = store.create({});
  const first = store.resolve(secret)?.expiresAt ?? 0;
  clock += 25 * 60 * 60 * 1000;
  const second = store.resolve(secret)?.expiresAt ?? 0;
  expect(second).toBeGreaterThan(first);
  expect(second).toBe(clock + SESSION_TTL_MS);
});

it("leaves the expiry alone on a busy session", () => {
  const store = new SessionStore(app.db, now);
  const secret = store.create({});
  const first = store.resolve(secret)?.expiresAt ?? 0;
  clock += 60 * 1000;
  expect(store.resolve(secret)?.expiresAt).toBe(first);
});

it("revokes one session, all sessions, and all but one", () => {
  const store = new SessionStore(app.db, now);
  const a = store.create({});
  const b = store.create({});
  store.revoke(a);
  expect(store.resolve(a)).toBeNull();
  expect(store.resolve(b)).not.toBeNull();

  const c = store.create({});
  store.revokeOthers(c);
  expect(store.resolve(b)).toBeNull();
  expect(store.resolve(c)).not.toBeNull();

  store.revokeAll();
  expect(store.resolve(c)).toBeNull();
});

it("purges only the expired rows", () => {
  const store = new SessionStore(app.db, now);
  store.create({});
  clock += SESSION_TTL_MS + 1;
  const fresh = store.create({});
  expect(store.purgeExpired()).toBe(1);
  expect(store.resolve(fresh)).not.toBeNull();
});
