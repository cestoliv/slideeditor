import { outputHeight } from "@shared/geometry/index.js";
import type { Project } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { renderSlideBlob } from "./render.js";

/*
 * Rendering a whole slideshow for the server, so an agent can hand its slides
 * to a scheduling tool. The pixels are the same ones ExportMenu downloads:
 * renderSlideBlob is the only renderer in this codebase, and putting a second
 * one on the server is what this whole feature was designed to avoid.
 */

/**
 * A blob as bare base64, the shape the upload route decodes.
 *
 * FileReader gives a data URL, but the render route's decodePng
 * (src/server/routes/projects.ts:146-153) strips no prefix — unlike the
 * library upload route, it accepts bare base64 only and 400s on anything
 * else. This encodes to that shape directly rather than through FileReader.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked, because a full resolution PNG is megabytes and spreading that many
  // arguments into String.fromCharCode overflows the call stack.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export interface PublishInput {
  project: Project;
  library: LibraryIndex;
  upload: (index: number, data: string) => Promise<unknown>;
}

/**
 * Renders and uploads every slide, one at a time, in order.
 *
 * Sequential rather than parallel: each render holds a full resolution canvas,
 * and six of those at once is memory a phone does not have. It is also what
 * ExportMenu's renderAll already does.
 *
 * A failure propagates rather than being swallowed. A partial upload leaves the
 * server with fewer renders than slides, which export_slideshow reports as
 * pending, so the caller's job is to say so rather than to repair it.
 */
export async function publishRenders({
  project,
  library,
  upload,
}: PublishInput): Promise<number> {
  const height = outputHeight(project.ratio);
  for (const [index, slide] of project.slides.entries()) {
    const blob = await renderSlideBlob(slide, { height, assets: library });
    await upload(index, await blobToBase64(blob));
  }
  return project.slides.length;
}
