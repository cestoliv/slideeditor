/*
 * The system share sheet. Ported from shareActiveSlide (app.js:4315-4351) and
 * shareAllSlides (app.js:4353-4402).
 *
 * Only the browser questions live here. Which files to share, and the cache
 * that keeps them ready inside a user gesture, belong to ExportMenu.
 */

/**
 * True when this browser will put these files on the share sheet.
 *
 * `navigator.canShare` is absent on desktop Firefox and on every browser too
 * old for the API, and present but false for files on desktop Chrome, so both
 * the absence and the answer have to be checked.
 */
export function canShareFiles(files: File[]): boolean {
  if (files.length === 0) return false;
  return navigator.canShare?.({ files }) === true;
}

/**
 * True while the browser still counts the page as acting on a user's press.
 *
 * Safari refuses navigator.share once the activation has lapsed, which is what
 * rendering a slideshow's worth of PNGs does. app.js:4384 checks this before
 * sharing so it can ask the reader to press again rather than throwing.
 * A browser with no userActivation at all has no such rule to break.
 */
export function hasUserActivation(): boolean {
  return navigator.userActivation?.isActive !== false;
}

/** The reader closed the sheet. Nothing failed, so nothing is reported. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * The gesture had lapsed by the time the sheet was asked for. The files are
 * built, so the answer is to ask for another press rather than to start again.
 */
export function isNotAllowed(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}

/**
 * Opens the share sheet on these files.
 *
 * canShareFiles is asked first, because navigator.share rejects with a
 * TypeError on a browser that has the method and not the file support, and a
 * TypeError reads to a caller as a bug rather than as a browser saying no.
 */
export async function shareFiles(files: File[], title: string): Promise<void> {
  if (!canShareFiles(files)) {
    throw new Error("This browser cannot share files.");
  }
  await navigator.share({ files, title });
}
