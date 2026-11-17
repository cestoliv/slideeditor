// The built-in face. injectFontFaces leaves it out of the catalogue because
// main.tsx loads it from this same stylesheet.
import "./design/fonts.css";
import type { LibraryItem } from "@shared/schema/index.js";
import { api } from "./app/api.js";
import { injectFontFaces } from "./app/fontFaces.js";
import { publishRenders } from "./features/editor/export/publish.js";

/*
 * The page the server opens in headless Chromium to render a ready slideshow
 * with no editor tab open (src/server/services/render.ts). It runs the same
 * steps as usePublishOnReady, through the same API, so the server stores the
 * pixels the editor would have uploaded.
 */

async function renderSlideshow(id: string, version: number): Promise<number> {
  await injectFontFaces();
  const { project } = await api.getProject(id);
  // The server asked for one version. Rendering a newer one would file pixels
  // for a composition the caller never read, and the upload route refuses an
  // older one, so either way this stops here.
  if (project.version !== version) {
    throw new Error(
      `Slideshow ${id} is at version ${String(project.version)}, not ${String(version)}.`,
    );
  }
  const ids = new Set(
    project.slides.flatMap((slide) => [
      slide.backgroundItemId,
      ...slide.overlays.map((overlay) => overlay.itemId),
    ]),
  );
  // Fetched by id rather than through a library page, so an item never misses
  // because it sits past the page size.
  const entries = await Promise.all(
    [...ids].map(async (itemId) => {
      const { item } = await api.getLibraryItem(itemId);
      return [itemId, item] as [string, LibraryItem];
    }),
  );
  return publishRenders({
    project,
    library: new Map(entries),
    upload: (index, data) => api.putProjectRender(id, index, { version, data }),
  });
}

declare global {
  interface Window {
    renderSlideshow: typeof renderSlideshow;
  }
}

window.renderSlideshow = renderSlideshow;
