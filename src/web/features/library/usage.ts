import type { LibraryStats } from "@shared/schema/index.js";

/*
 * How often an image has been used, in words. Ported from app.js:1378-1394.
 *
 * An agent picks images partly on how tired they are, so a person curating the
 * library needs to see the same thing the agent sees. Both helpers take the
 * current time as a parameter, which the screen never passes and a test always
 * does.
 */

const DAY = 86400000;

/** Plain language, because the number alone does not say whether it is a lot. */
export function describeUsage(stats: LibraryStats, now: number = Date.now()): string {
  if (stats.timesUsed <= 0) return "never used";
  const uses = `${String(stats.timesUsed)} ${stats.timesUsed === 1 ? "use" : "uses"}`;
  const shows = `${String(stats.slideshowCount)} ${
    stats.slideshowCount === 1 ? "slideshow" : "slideshows"
  }`;
  return `${uses} across ${shows} · last used ${relativeDate(stats.lastUsedAt, now)}`;
}

export function relativeDate(timestamp: number | null, now: number = Date.now()): string {
  // The server writes no timestamp at all for an unused item, and a numeric
  // column with nothing in it reads as the epoch, which is the same answer.
  if (timestamp === null || timestamp === 0) return "never";
  const days = Math.floor((now - timestamp) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${String(days)} days ago`;
  const months = Math.floor(days / 30);
  return `${String(months)} ${months === 1 ? "month" : "months"} ago`;
}
