import { useCallback, useEffect, useState } from "react";
import { api, authEvents, type SessionState } from "./api.js";
import { ensureFontFacesLoaded } from "./fontFaces.js";

export type SessionStatus =
  | { status: "loading" }
  | { status: "ready"; session: SessionState }
  | { status: "unreachable" };

/**
 * The first call the app makes. Until it answers there is nothing to render:
 * showing the editor and then replacing it with a login form reads as a crash.
 */
export function useSession(): { state: SessionStatus; refresh: () => void } {
  const [state, setState] = useState<SessionStatus>({ status: "loading" });

  const refresh = useCallback(() => {
    api
      .session()
      .then((session) => {
        // Fired here, synchronously in the resolved-promise handler, rather
        // than from a useEffect on App.tsx's Gate or anything it renders.
        // /api/fonts sits behind the same auth guard everything else does, so
        // this has to happen on the exact transition to authenticated rather
        // than at module load (which 401s on a password-protected install and
        // never gets retried) — and it has to happen before setState below,
        // not after: React runs effects child-first, so an effect anywhere
        // under the gate (the editor a deep link mounts on this very
        // transition, say) would fire before an effect placed up at the gate
        // ever got the chance to, and the family it asks for would find
        // whenCatalogueReady() still resolved from before this call. Calling
        // it here, ahead of the state update that causes any of that to
        // mount, sidesteps React's effect ordering entirely.
        //
        // ensureFontFacesLoaded() rather than injectFontFaces() directly:
        // this handler reruns on every authenticated probe, not only the
        // first — any 401 anywhere re-runs refresh() to check the cookie is
        // still good, and StrictMode double-invokes this effect once more in
        // dev — and only the first one is a real sign-in that needs a fetch.
        if (session.authenticated) ensureFontFacesLoaded();
        setState({ status: "ready", session });
      })
      .catch(() => setState({ status: "unreachable" }));
  }, []);

  useEffect(refresh, [refresh]);

  // A 401 anywhere in the app means the cookie this hook already confirmed is
  // no longer good. Re-probing rather than assuming "logged out" is what lets
  // this same effect also recover from the server having restarted.
  useEffect(() => {
    authEvents.addEventListener("unauthorized", refresh);
    return () => authEvents.removeEventListener("unauthorized", refresh);
  }, [refresh]);

  return { state, refresh };
}
