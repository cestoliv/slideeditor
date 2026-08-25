import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadToken } from "./legacyToken.js";

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
