import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import "../provided.js";

// Vitest has to know where to forward /api, /media and /mcp before this file
// runs, so the port is fixed rather than picked by the kernel. It matches the
// e2e project's proxy in vitest.config.ts.
const PORT = Number(process.env["SLIDE_STUDIO_E2E_PORT"]) || 4174;

/**
 * The origin the server mints edit URLs against.
 *
 * Without this `buildApp` falls back to DEFAULT_BASE_URL, port 4173, while this
 * server listens on 4174. Every editUrl an agent was handed then named a port
 * nothing serves, and no test could see it: they asserted the path alone. The
 * origin is this server's own, so a regression that mints the wrong one fails
 * `agent-flow.e2e.test.ts` rather than passing quietly.
 */
const E2E_ORIGIN = `http://127.0.0.1:${String(PORT)}`;

export default async function setup(project: TestProject) {
  project.provide("e2eOrigin", E2E_ORIGIN);
  const dataDir = mkdtempSync(join(tmpdir(), "slide-studio-e2e-"));
  const { buildApp } = await import("../../../src/server/app.js");
  const app = await buildApp({ dataDir, baseUrl: () => E2E_ORIGIN });
  // The browser page is served by Vitest and that origin forwards this server's
  // paths, so the tests fetch relative URLs and never leave it. The address is
  // exported for the one assertion that checks the edit URL an agent receives.
  await listen(app, dataDir);
  return async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

type App = Awaited<ReturnType<typeof import("../../../src/server/app.js").buildApp>>;

/**
 * A fixed port can be taken, which port 0 never was. The bind error Node throws
 * says only EADDRINUSE, so this says which port, how to move it, and what
 * usually holds it.
 */
async function listen(app: App, dataDir: string): Promise<string> {
  try {
    return await app.listen({ port: PORT, host: "127.0.0.1" });
  } catch (error) {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (!isAddressInUse(error)) throw error;
    throw new Error(
      [
        `The end-to-end server cannot bind 127.0.0.1:${PORT}, because something else already holds it.`,
        "The port is fixed because vitest.config.ts proxies the browser's /api, /media and /mcp to it.",
        `Set SLIDE_STUDIO_E2E_PORT to move both, or free the port. A stray server from an interrupted`,
        `run is the usual cause: lsof -ti tcp:${PORT} names it.`,
      ].join("\n"),
      { cause: error },
    );
  }
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
