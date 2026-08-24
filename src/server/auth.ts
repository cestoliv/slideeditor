import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Ported from server/auth.mjs:7-13. */
export function loadToken(tokenPath: string): string {
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isLoopback(remoteAddress: string | undefined): boolean {
  return LOOPBACK.has(remoteAddress ?? "");
}

/** The three fields the old node:http request carried into isAuthorized. */
export interface AuthRequest {
  remoteAddress: string | undefined;
  authorization: string | undefined;
  url: string;
}

/** Loopback skips the token, so the local editor needs no configuration. */
export function isAuthorized(request: AuthRequest, token: string): boolean {
  if (isLoopback(request.remoteAddress)) return true;
  const match = /^Bearer\s+(.+)$/i.exec((request.authorization ?? "").trim());
  const presented = match
    ? (match[1] ?? "").trim()
    : (new URL(request.url, "http://localhost").searchParams.get("token") ?? "");
  if (!presented) return false;
  const offered = Buffer.from(presented);
  const expected = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, so the length decides first.
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/**
 * Blocks DNS rebinding: a hostile page must not be able to reach this server by
 * pointing a name it controls at a local address. Rebinding needs a hostname,
 * so a bare IP literal cannot be used for it and is always allowed.
 */
export function isAllowedHost(
  host: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  const raw = String(host ?? "").trim();
  if (!raw) return true;
  const name = raw.startsWith("[")
    ? raw.slice(0, raw.indexOf("]") + 1).toLowerCase()
    : (raw.split(":")[0] ?? "").toLowerCase();
  if (IPV4.test(name) || name.startsWith("[")) return true;
  return allowedHosts.includes(name);
}
