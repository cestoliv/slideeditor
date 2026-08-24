/*
 * The caption a slideshow is posted with: the description, and the hashtags
 * that go under it. Both are columns on the project row rather than fields in
 * the document, because they describe the slideshow rather than its slides,
 * exactly as its name and its status do.
 *
 * The normalisers live in src/shared so the server and the editor agree on what
 * a hashtag list is. If only the server knew, the field on screen and the text
 * the copy button hands over would say one thing and the stored caption
 * another, and the copy button exists to be pasted somewhere else.
 */

/** TikTok and Instagram both stop reading a caption at 2200 characters. */
export const DESCRIPTION_LIMIT = 2200;

/** Instagram refuses a post carrying more than 30 hashtags. */
export const HASHTAG_LIMIT = 30;

/** Free text, kept as written. Anything that is not text carries no caption. */
export function normalizeDescription(value: unknown): string {
  return typeof value === "string" ? value.slice(0, DESCRIPTION_LIMIT) : "";
}

/**
 * Every shape a caller might send, as the one shape everything returns: tags
 * separated by a single space, each carrying exactly one leading `#`.
 *
 * A list and a string are both accepted, because an agent thinks in tags and a
 * person types a line. Separators are whitespace and commas, a leading `#` is
 * optional on the way in and always present on the way out, and a tag repeated
 * in any casing is kept once so a copied caption never says `#travel #Travel`.
 */
export function normalizeHashtags(value: unknown): string {
  const source: unknown[] = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    for (const token of entry.split(/[\s,]+/)) {
      const tag = token.replace(/^#+/, "");
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(`#${tag}`);
      if (tags.length === HASHTAG_LIMIT) return tags.join(" ");
    }
  }
  return tags.join(" ");
}
