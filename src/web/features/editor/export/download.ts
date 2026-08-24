import type { Slide } from "@shared/schema/index.js";

/*
 * Naming an export and handing it to the browser. Ported from safeFilename
 * (app.js:4585-4592), slideExportName (app.js:4247-4250) and downloadBlob
 * (app.js:4276-4283).
 */

/**
 * A filename safe on every filesystem, ported verbatim from app.js:4585-4592.
 *
 * Anything that is not a lowercase letter or a digit becomes a hyphen, and a
 * name left with nothing becomes "slide", so a slideshow called "!!!" still
 * exports a file someone can open.
 */
export function safeFilename(value: string | null | undefined): string {
  return (
    String(value || "slide")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "slide"
  );
}

/**
 * What one slide's PNG is called (app.js:4247-4250).
 *
 * app.js read the project's name off a global, so its signature took only the
 * slide and the index. Nothing here has a global to read, so the name is a
 * parameter. `index` stays last and stays optional, because a single-slide
 * download has no ordinal and the batch download does.
 */
export function slideExportName(
  slide: Slide,
  projectName: string,
  index: number | null = null,
): string {
  const order = index === null ? "" : `${String(index + 1).padStart(2, "0")}-`;
  return `${order}${safeFilename(projectName)}-${safeFilename(slide.name)}.png`;
}

/** What the whole slideshow's archive is called (app.js:4300). */
export function zipExportName(projectName: string): string {
  return `${safeFilename(projectName)}.zip`;
}

/** app.js:4281. Long enough for the browser to have taken the blob. */
const REVOKE_DELAY_MS = 1000;

/**
 * Hands a blob to the browser as a download (app.js:4276-4283).
 *
 * The object URL is revoked on a timer rather than straight away, because the
 * download reads it after the click returns and a URL revoked in the same tick
 * takes the file with it.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
