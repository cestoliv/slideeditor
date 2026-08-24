import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isAllowedHost, isAuthorized, isLoopback, loadToken } from "./auth.js";

const request = (remoteAddress: string, authorization?: string) => ({
  remoteAddress,
  authorization,
  url: "/api/health",
});

it("loopback skips the token and everything else needs it", () => {
  expect(isAuthorized(request("127.0.0.1"), "secret")).toBe(true);
  expect(isAuthorized(request("::1"), "secret")).toBe(true);
  expect(isAuthorized(request("192.168.1.20"), "secret")).toBe(false);
  expect(isAuthorized(request("192.168.1.20", "Bearer secret"), "secret")).toBe(true);
  expect(isAuthorized(request("192.168.1.20", "Bearer wrong"), "secret")).toBe(false);
  expect(isAuthorized(request("192.168.1.20", "Bearer secretlonger"), "secret")).toBe(
    false,
  );
});

it("reads the token from the query string when there is no header", () => {
  const url = (query: string) => ({
    remoteAddress: "192.168.1.20",
    authorization: undefined,
    url: query,
  });
  expect(isAuthorized(url("/api/health?token=secret"), "secret")).toBe(true);
  expect(isAuthorized(url("/api/health?token=other"), "secret")).toBe(false);
  expect(isAuthorized(url("/api/health"), "secret")).toBe(false);
});

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

it("writes the token once and reads the same one back", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "slide-studio-token-")),
    "nested",
    "token",
  );
  const token = loadToken(path);
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(loadToken(path)).toBe(token);
  expect(readFileSync(path, "utf8")).toBe(`${token}\n`);
  // The file holds a credential, so nobody else on the machine may read it.
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
