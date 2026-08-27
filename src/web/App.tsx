import { BrowserRouter } from "react-router";
import { ToastProvider, Tooltip } from "./design/index.js";
import { AccountsProvider } from "./app/accounts.js";
import { ProjectsProvider } from "./app/projects.js";
import { AppRoutes } from "./app/router.js";
import { useSession } from "./app/session.js";
import { LoginScreen } from "./features/auth/LoginScreen.js";

/*
 * The app root. The slideshow list and its live stream sit above the router, so
 * a navigation neither drops the subscription nor re-reads the list.
 */
export function App() {
  return (
    <BrowserRouter>
      <Tooltip.Provider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </Tooltip.Provider>
    </BrowserRouter>
  );
}

/**
 * Nothing renders until the session probe answers. Showing the editor and then
 * replacing it with a login form reads as a crash, and ProjectsProvider would
 * have fired a request that 401s on the way, so it sits inside the gate rather
 * than above it.
 *
 * The font catalogue fetch (injectFontFaces()) lives behind the same guard for
 * the same reason, so it is not made from here or from anything this renders:
 * useSession's own refresh() is where it is triggered, on the exact
 * authenticated transition this gate is reading — see that file's comment for
 * why it has to happen there rather than in an effect somewhere under this
 * tree.
 */
function Gate() {
  const { state, refresh } = useSession();
  if (state.status === "loading") return null;
  if (state.status === "unreachable") {
    return <p role="alert">Slide Studio is not answering.</p>;
  }
  if (!state.session.authenticated) return <LoginScreen onSignedIn={refresh} />;
  return (
    <ProjectsProvider>
      <AccountsProvider>
        <AppRoutes />
      </AccountsProvider>
    </ProjectsProvider>
  );
}
