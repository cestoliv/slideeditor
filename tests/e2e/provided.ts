// A type-only import, so this file augments Vitest without pulling the runner
// into the global setup, which runs in Node before any runner exists.
import type {} from "vitest";

/*
 * What the global setup hands the tests.
 *
 * The browser cannot read the setup process's environment, and
 * SLIDE_STUDIO_E2E_PORT moves the port, so the origin travels rather than being
 * recomputed on the other side: a test recomputing it would agree with itself
 * on the wrong port.
 *
 * This lives outside setup/ because tsconfig.web.json excludes that directory,
 * and the browser half of the suite is the half that reads the value.
 */
declare module "vitest" {
  interface ProvidedContext {
    e2eOrigin: string;
  }
}
