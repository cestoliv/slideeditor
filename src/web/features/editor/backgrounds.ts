import type { LibraryItem } from "@shared/schema/index.js";
import { uploadLibraryFile } from "../library/upload.js";

/*
 * Putting a chosen image into the library so a slide can point at it.
 *
 * This once carried its own copy of the reader, the name and the accept list.
 * Task 12 later wrote the same three in features/library/upload.ts and wrote
 * them better: its isImageFile falls back to the extension, because a picker
 * can hand back a file whose type the browser never worked out, and its
 * nameForFile has an answer for a file with no name at all. Two copies of a
 * filter is how one of them ends up wrong, so this delegates and re-exports
 * rather than keeping a second.
 */

export { IMAGE_ACCEPT, isImageFile } from "../library/upload.js";

export type BackgroundUploader = (file: File) => Promise<LibraryItem>;

/** One image, as a background. The server measures it, so no size is sent. */
export function uploadBackgroundItem(
  file: File,
  accountId: string,
): Promise<LibraryItem> {
  return uploadLibraryFile("background", file, accountId);
}
