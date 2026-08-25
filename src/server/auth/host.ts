const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isLoopback(remoteAddress: string | undefined): boolean {
  return LOOPBACK.has(remoteAddress ?? "");
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
