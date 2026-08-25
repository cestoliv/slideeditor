// The design layer loads first so component stylesheets cascade over the reset.
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/reset.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { adoptTokenFromUrl } from "./app/api.js";

// Before the first request goes out, and before the first render puts the
// address bar on screen: the README opens the editor from another machine as
// `http://<ip>:4173/?token=<token>`, and that token belongs in this session
// rather than in the URL.
adoptTokenFromUrl();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing the #root container.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
