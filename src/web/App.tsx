import { BrowserRouter } from "react-router";
import { ToastProvider, Tooltip } from "./design/index.js";
import { ProjectsProvider } from "./app/projects.js";
import { AppRoutes } from "./app/router.js";

/*
 * The app root. The slideshow list and its live stream sit above the router, so
 * a navigation neither drops the subscription nor re-reads the list.
 */
export function App() {
  return (
    <BrowserRouter>
      <Tooltip.Provider>
        <ToastProvider>
          <ProjectsProvider>
            <AppRoutes />
          </ProjectsProvider>
        </ToastProvider>
      </Tooltip.Provider>
    </BrowserRouter>
  );
}
