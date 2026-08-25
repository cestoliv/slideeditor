import { createHash, randomBytes } from "node:crypto";

/** Names a token secret in a log or a repository scan. */
export const TOKEN_PREFIX = "sst_";

// 32 bytes is 256 bits of entropy, which is why these are hashed with SHA-256
// rather than scrypt: there is nothing to brute force.
const SECRET_BYTES = 32;
const PREFIX_LENGTH = TOKEN_PREFIX.length + 4;

export function newSessionId(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function newTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Enough to tell two tokens apart in a list, far too little to guess one. */
export function tokenPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LENGTH);
}
