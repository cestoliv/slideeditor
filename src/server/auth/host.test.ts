import { expect, it } from "vitest";
import { isAllowedHost, isLoopback } from "./host.js";

it("knows which addresses are the local machine", () => {
  expect(isLoopback("127.0.0.1")).toBe(true);
  expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopback("10.0.0.4")).toBe(false);
  expect(isLoopback(undefined)).toBe(false);
});

it("only allows known Host headers", () => {
  const allowed = ["localhost", "127.0.0.1"];
  expect(isAllowedHost("localhost:4173", allowed)).toBe(true);
  expect(isAllowedHost("127.0.0.1:4173", allowed)).toBe(true);
  expect(isAllowedHost("evil.example.com", allowed)).toBe(false);
});

it("allows a request that carries no Host header, and any IP literal", () => {
  expect(isAllowedHost(undefined, ["studio.local"])).toBe(true);
  expect(isAllowedHost("  ", ["studio.local"])).toBe(true);
  expect(isAllowedHost("10.1.2.3:4173", ["studio.local"])).toBe(true);
  expect(isAllowedHost("[::1]:4173", ["studio.local"])).toBe(true);
  expect(isAllowedHost("STUDIO.local", ["studio.local"])).toBe(true);
});
