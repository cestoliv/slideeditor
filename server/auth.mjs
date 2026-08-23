import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function loadToken(tokenPath) {
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isLoopback(request) {
  return LOOPBACK.has(request.socket.remoteAddress || "");
}

/** Loopback skips the token, so the local editor needs no configuration. */
export function isAuthorized(request, token) {
  if (isLoopback(request)) return true;
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match ? match[1].trim() : new URL(request.url, "http://localhost").searchParams.get("token") || "";
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Blocks DNS rebinding: a hostile page must not be able to reach this server by
 * pointing a name it controls at a local address. Rebinding needs a hostname,
 * so a bare IP literal cannot be used for it and is always allowed.
 */
export function isAllowedHost(request, allowedHosts) {
  const raw = String(request.headers.host || "").trim();
  if (!raw) return true;
  const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1).toLowerCase() : raw.split(":")[0].toLowerCase();
  if (IPV4.test(host) || host.startsWith("[")) return true;
  return allowedHosts.includes(host);
}
