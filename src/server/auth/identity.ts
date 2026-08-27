export type Identity =
  { kind: "token"; id: string } | { kind: "session"; id: string } | { kind: "open" };

/** What a path accepts, independent of what a request happens to carry. */
export type Guard = "any" | "token" | "session" | "none";

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * `/api/health` stays open for the container healthcheck, and reports two
 * constants. `/api/auth/session` and `/api/auth/login` stay open because the
 * login screen needs them before any credential exists.
 */
const OPEN_PATHS = new Set(["/api/health", "/api/auth/session", "/api/auth/login"]);

export function guardFor(target: string): Guard {
  // Lowercased for the decision only, never for routing. Fastify matches routes
  // case-sensitively today, so `/MEDIA/x.png` reaches no handler either way,
  // but the guard must not depend on a setting that lives in another file: the
  // one direction this can move a path is public to guarded.
  const path = ((target ?? "").split("?")[0] ?? "").toLowerCase();
  if (OPEN_PATHS.has(path)) return "none";
  // A leaked token must not be able to mint more tokens or change the password.
  if (path.startsWith("/api/auth/")) return "session";
  // An agent endpoint reached by ambient browser credentials is a cross site
  // request forgery surface with no benefit.
  if (path === "/mcp") return "token";
  // An agent follows the media URLs the MCP tools hand it, so a token reaches
  // media even though a browser session does too.
  if (path.startsWith("/api/") || path.startsWith("/media/")) return "any";
  // /fonts/<slug>.<ext> serves only the handful of open-source font binaries
  // bundled under assets/ (routes/fonts.ts's BUILTIN_FONTS_DIR) — never a
  // per-account or per-user file, unlike /media/, which also serves uploaded
  // library images through the same URL shape and stays guarded for that
  // reason. The login screen has to render a brand face before any
  // credential exists, so this is deliberately public. Named explicitly
  // rather than left to fall through to the same "none" default, so a future
  // route added under this prefix does not inherit public access by
  // accident without someone re-deciding this.
  if (path.startsWith("/fonts/")) return "none";
  return "none";
}

export function bearerFrom(authorization: string | undefined): string {
  const match = BEARER.exec((authorization ?? "").trim());
  return (match?.[1] ?? "").trim();
}

/**
 * SameSite=Lax already blocks a cross site form post carrying the cookie. This
 * is the second lock, for the fetch case: a cookie authenticated write has to
 * come from this server's own origin. A bearer request skips it, because a
 * header is never sent ambiently.
 *
 * An absent Origin passes. Same origin GET and some older browsers omit it, and
 * a forged request cannot choose to omit it in any browser that sends it.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    // The WHATWG URL parser already drops a default port from `url.host`, but a
    // proxy may still send one explicitly on the Host header (`example.com:443`),
    // so that side is stripped the same way before comparing.
    const defaultPort =
      url.protocol === "https:" ? ":443" : url.protocol === "http:" ? ":80" : "";
    const requestHost =
      defaultPort && host.toLowerCase().endsWith(defaultPort)
        ? host.slice(0, -defaultPort.length)
        : host;
    return url.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    // "null", which a sandboxed frame sends.
    return false;
  }
}
