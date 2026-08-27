// The design layer loads first so component stylesheets cascade over the reset.
import "./design/tokens.css";
import "./design/reset.css";
// The one @font-face this app ships statically, so the built-in face is
// there before sign-in. reset.css names "TikTok Sans" as the whole app's
// base font (--font-family-base), and App.tsx's Gate renders LoginScreen (and
// its own "not answering" fallback) before a session is known at all —
// before injectFontFaces() below has any chance to run. Without this, both
// screens painted in the system-ui fallback and the whole UI reflowed the
// moment injectFontFaces() finally ran post-auth. Every OTHER family an
// account might add still comes from the fetched catalogue only.
import "./design/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// The full per-account catalogue (Google fonts, and the builtin's own
// weight-range declaration, which fonts.css's static import above
// deliberately matches) is still fetched only once authenticated — /api/fonts
// sits behind the same auth guard as everything else, so calling
// injectFontFaces() at module load, before the session probe has even run,
// would just 401. It runs from session.ts's useSession() hook once that
// probe resolves authenticated (see App.tsx's Gate and session.ts's
// refresh()).

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing the #root container.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
