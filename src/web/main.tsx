// The design layer loads first so component stylesheets cascade over the reset.
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/reset.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing the #root container.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
