import { expect, it } from "vitest";
import {
  TOKEN_PREFIX,
  hashSecret,
  newSessionId,
  newTokenSecret,
  tokenPrefix,
} from "./secrets.js";

it("mints session ids that do not repeat", () => {
  const id = newSessionId();
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newSessionId()).not.toBe(id);
});

it("marks token secrets so a leaked one is recognisable", () => {
  const secret = newTokenSecret();
  expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
  expect(secret).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
});

it("hashes to stable lowercase hex", () => {
  expect(hashSecret("abc")).toBe(hashSecret("abc"));
  expect(hashSecret("abc")).toMatch(/^[0-9a-f]{64}$/);
  expect(hashSecret("abc")).not.toBe(hashSecret("abd"));
});

it("takes a display prefix that reveals nothing usable", () => {
  const secret = "sst_abcdefghijklmnop";
  expect(tokenPrefix(secret)).toBe("sst_abcd");
  expect(tokenPrefix("short")).toBe("short");
});
