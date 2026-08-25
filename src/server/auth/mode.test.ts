import { expect, it } from "vitest";
import { asHttpError, catchError } from "../testing.js";
import { resolveAuthMode } from "./mode.js";

it("runs open on a loopback bind with no password", () => {
  expect(resolveAuthMode({ hasPassword: false, host: "127.0.0.1" })).toBe("open");
  expect(resolveAuthMode({ hasPassword: false, host: "::1" })).toBe("open");
});

it("requires auth as soon as a password exists, whatever the bind", () => {
  expect(resolveAuthMode({ hasPassword: true, host: "127.0.0.1" })).toBe("required");
  expect(resolveAuthMode({ hasPassword: true, host: "0.0.0.0" })).toBe("required");
});

it("refuses to start on a public bind with no password", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
    const error = asHttpError(
      await catchError(() => resolveAuthMode({ hasPassword: false, host })),
    );
    expect(error.message).toContain("SLIDE_STUDIO_PASSWORD");
  }
});
