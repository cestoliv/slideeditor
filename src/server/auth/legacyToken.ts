/*
 * The ambient shared token this server used before it had accounts. Nothing
 * authenticates with it any more. Migration 3 reads the file it writes and
 * seeds `auth_token` from it, so a script that already sends this value keeps
 * working, and this stays only to name and find that file.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Ported from server/auth.mjs:7-13. */
export function loadToken(tokenPath: string): string {
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}
