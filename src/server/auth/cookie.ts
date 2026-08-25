import { SESSION_TTL_MS } from "./sessions.js";

export const SESSION_COOKIE = "slide_studio_session";

/**
 * `secure` comes from request.protocol, which reports http behind Caddy unless
 * trustProxy is on. A Secure cookie set on a connection the server believes is
 * plain http would never come back, so the flag follows what it sees rather
 * than being hardcoded.
 */
export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    path: "/" as const,
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
