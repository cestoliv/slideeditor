import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing.js";
import { CredentialStore } from "./credentials.js";

let app: TestApp;
let store: CredentialStore;
beforeEach(() => {
  app = createTestApp();
  store = new CredentialStore(app.db);
});
afterEach(() => app.close());

it("starts with no password", () => {
  expect(store.hasPassword()).toBe(false);
  expect(store.verify("anything")).toBe(false);
});

it("seeds once and then leaves the stored password alone", () => {
  expect(store.seed("first")).toBe(true);
  expect(store.seed("second")).toBe(false);
  expect(store.verify("first")).toBe(true);
  expect(store.verify("second")).toBe(false);
});

it("replaces the password on an explicit set", () => {
  store.seed("first");
  store.setPassword("second");
  expect(store.verify("second")).toBe(true);
  expect(store.verify("first")).toBe(false);
});

it("stores a hash rather than the password", () => {
  store.seed("plaintext");
  const stored = app.db.prepare("SELECT password_hash FROM auth_credential").get();
  expect(stored?.["password_hash"]).not.toBe("plaintext");
  expect(String(stored?.["password_hash"])).toMatch(/^scrypt\$/);
});
