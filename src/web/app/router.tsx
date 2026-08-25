import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useParams } from "react-router";
import { Dashboard } from "../features/dashboard/Dashboard.js";
import { Editor } from "../features/editor/Editor.js";
import { LibraryAdmin } from "../features/library/LibraryAdmin.js";
import { NotFound } from "../features/shell/NotFound.js";

/*
 * Every screen the app has a URL for. Ported from routeFromPathname
 * (app.js:199-209), which read window.location itself and re-rendered the whole
 * document on every navigation.
 */

/** The kinds the library admin answers to, and the schema kind each one means. */
const LIBRARY_KINDS: Record<string, "background" | "asset"> = {
  backgrounds: "background",
  assets: "asset",
};

/*
 * The gallery is a development tool that pulls in every primitive twice over.
 * import.meta.env.DEV is a literal by the time Rollup sees it, so in a
 * production build this whole expression is dead and the dynamic import goes
 * with it. Keep the import inside the conditional: hoisting it would emit the
 * chunk in every build.
 */
const Gallery = import.meta.env.DEV
  ? lazy(async () => ({
      default: (await import("../design/gallery/Gallery.js")).Gallery,
    }))
  : null;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/projects/:id" element={<EditorRoute />} />
      <Route path="/library" element={<Navigate to="/library/backgrounds" replace />} />
      <Route path="/library/:kind" element={<LibraryRoute />} />
      {Gallery === null ? null : (
        <Route
          path="/design"
          element={
            <Suspense fallback={null}>
              <Gallery />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function EditorRoute() {
  const { id } = useParams();
  // The path cannot match without the segment, so this is unreachable in
  // practice; answering with the not-found screen keeps it from being a crash
  // if it ever becomes reachable.
  if (id === undefined) return <NotFound />;
  return <Editor projectId={id} />;
}

function LibraryRoute() {
  const { kind } = useParams();
  const wanted = LIBRARY_KINDS[kind ?? ""];
  // app.js:200 matched backgrounds and assets and nothing else.
  if (wanted === undefined) return <NotFound />;
  // Keyed by kind, so the two tabs are two pages. Without it React reconciles
  // one component across the param change and the assets tab opens holding the
  // search, the sort and the list order left behind on backgrounds.
  return <LibraryAdmin key={wanted} kind={wanted} />;
}
