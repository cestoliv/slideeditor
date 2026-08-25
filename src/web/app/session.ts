import { useCallback, useEffect, useState } from "react";
import { api, authEvents, type SessionState } from "./api.js";

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
      .then((session) => setState({ status: "ready", session }))
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
