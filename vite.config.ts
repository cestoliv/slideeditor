import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
      "@assets": fileURLToPath(new URL("./assets", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    // render.html is the page the server opens in headless Chromium to draw
    // exports (src/server/services/render.ts).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        render: fileURLToPath(new URL("./render.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/media": "http://127.0.0.1:4173",
      "/mcp": "http://127.0.0.1:4173",
      "/fonts": "http://127.0.0.1:4173",
    },
  },
});
