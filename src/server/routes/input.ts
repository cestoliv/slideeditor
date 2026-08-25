/** A parsed JSON body or query string, before anything reads a field out of it. */
export type Fields = Record<string, unknown>;

/** The old readJson resolved `{}` for an empty body, so a missing field reads as undefined. */
export function asFields(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Fields;
}

/**
 * Hands a field to a service exactly as it arrived. The old router passed
 * `body.name`, `body.kind` and friends straight through, and the services do
 * their own coercion and quote what arrived in their error messages, so
 * shaping a value here would change an agent-visible message. It stays
 * `unknown` all the way to the service, which is where it gets checked.
 */
export function field(fields: Fields, key: string): unknown {
  return fields[key];
}

/**
 * The first value for a repeated query parameter, which is what
 * URLSearchParams.get gave the old router.
 */
export function queryValue(query: unknown, key: string): string | null {
  const value = asFields(query)[key];
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    return typeof list[0] === "string" ? list[0] : null;
  }
  return typeof value === "string" ? value : null;
}

/** A query parameter read as a count, left out when it is not one so the service default applies. */
export function countValue(query: unknown, key: string): number | undefined {
  const raw = queryValue(query, key);
  if (raw === null) return undefined;
  const count = Number.parseInt(raw, 10);
  return Number.isNaN(count) ? undefined : count;
}
