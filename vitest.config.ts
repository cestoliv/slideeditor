import { defineConfig } from "vitest/config";
import { coverageConfigDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Node projects may see every root, because they run the same resolver the build does.
const nodeAlias = {
  "@shared": path("./src/shared"),
  "@server": path("./src/server"),
  "@web": path("./src/web"),
  "@assets": path("./assets"),
};

// The browser projects drop @server, so a passing browser test cannot import
// server code that `vite build` would then refuse to bundle.
const webAlias = {
  "@shared": path("./src/shared"),
  "@web": path("./src/web"),
  "@assets": path("./assets"),
};

// Fastify serves the client and the API together, so the end-to-end browser
// must see them on one origin. Vitest serves the page, and these paths are
// forwarded to the server tests/e2e/setup/server.ts starts on this port.
const e2ePort = Number(process.env.SLIDE_STUDIO_E2E_PORT) || 4174;
const e2eTarget = `http://127.0.0.1:${e2ePort}`;

// Vitest names each browser instance in place, so every project needs its own
// object rather than a shared one.
const chromium = () => ({
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: "chromium" as const }],
  // screenshotDirectory names the directory for failure captures and for
  // toMatchScreenshot baselines alike, so no value of it separates the two.
  // Turning failure captures off leaves the default location free to hold
  // baselines that Task 17 commits. Diffs go to .vitest-attachments regardless.
  screenshotFailures: false,
});

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/shared/**", "src/server/**"],
      // What is left here is a test helper and a one-line tsx entry point.
      // cli.ts is not: Task 9 gave it flag parsing, a banner and a start, and
      // src/server/cli.test.ts covers them.
      exclude: [
        ...coverageConfigDefaults.exclude,
        "**/*.test.ts",
        "src/server/testing.ts",
        "src/server/dev.ts",
      ],
      thresholds: {
        "src/shared/**": {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90,
        },
        "src/server/**": {
          statements: 85,
          branches: 75,
          functions: 85,
          lines: 85,
        },
      },
    },
    projects: [
      {
        resolve: { alias: nodeAlias },
        test: {
          name: "shared",
          environment: "node",
          // The editor's store, history, and selection are pure, so they run here.
          include: ["src/shared/**/*.test.ts", "src/web/features/editor/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: nodeAlias },
        test: {
          name: "server",
          environment: "node",
          include: ["src/server/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: webAlias },
        test: {
          name: "web",
          include: ["src/web/**/*.browser.test.tsx"],
          browser: chromium(),
        },
      },
      {
        resolve: { alias: webAlias },
        server: { proxy: { "/api": e2eTarget, "/media": e2eTarget, "/mcp": e2eTarget } },
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.e2e.test.ts"],
          globalSetup: ["tests/e2e/setup/server.ts"],
          testTimeout: 30000,
          browser: chromium(),
        },
      },
    ],
  },
});
