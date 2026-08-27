import type { LibraryItem, LibraryKind } from "@shared/schema/index.js";
import { api } from "../../app/api.js";

/*
 * Putting chosen files into the library. Ported from the upload half of
 * bindLibraryAdmin (app.js:1412-1429), which went through api.js's own helper.
 */

/** app.js:1338. What the picker offers, and what a chosen file is filtered by. */
export const IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif";

/**
 * app.js:4731-4734. A picker can hand back a file whose type the browser never
 * worked out, so the extension is the second chance rather than the only check.
 */
export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name)
  );
}

/** api.js read files this way too, so the server sees exactly what it always did. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("That file could not be read."));
    };
    reader.readAsDataURL(file);
  });
}

/** The file's name without its extension, which is the only name a picker gives. */
export function nameForFile(file: File, kind: LibraryKind): string {
  const stripped = file.name.replace(/\.[^.]+$/, "");
  return stripped === "" ? (kind === "asset" ? "Asset" : "Background") : stripped;
}

export type LibraryUploader = Pick<typeof api, "createLibraryItem">;

/**
 * Uploads one image. The server measures it itself
 * (src/server/services/library.ts:186), so no width or height is sent.
 */
export async function uploadLibraryFile(
  kind: LibraryKind,
  file: File,
  accountId: string,
  client: LibraryUploader = api,
): Promise<LibraryItem> {
  const { item } = await client.createLibraryItem({
    kind,
    name: nameForFile(file, kind),
    contentType: file.type === "" ? "image/png" : file.type,
    data: await fileToDataUrl(file),
    accountId,
  });
  return item;
}
