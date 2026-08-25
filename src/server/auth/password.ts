import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// OWASP's floor for scrypt. Stored in the hash rather than read from here, so
// raising them later leaves every existing password verifiable.
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * A stored value this cannot parse is a refusal rather than a throw. The only
 * caller is a login, and an unreadable row must lock the account rather than
 * crash the request that discovered it.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (![cost, blockSize, parallelism].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const offered = derive(password, salt, cost, blockSize, parallelism);
    return offered.length === expected.length && timingSafeEqual(offered, expected);
  } catch {
    // scryptSync throws on parameters outside its limits, which a corrupted
    // row can carry.
    return false;
  }
}

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
): Buffer {
  return scryptSync(password, salt, KEY_BYTES, {
    N: cost,
    r: blockSize,
    p: parallelism,
    // scrypt needs roughly 128 * N * r bytes, and Node's default cap is below
    // what N=16384, r=8 wants.
    maxmem: 64 * 1024 * 1024,
  });
}
