import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance | undefined;
let directory: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const headers = { host: "localhost", origin: "http://localhost" };

it("seeds the password from SLIDE_STUDIO_PASSWORD when no option is given", async () => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-env-"));
  const saved = process.env["SLIDE_STUDIO_PASSWORD"];
  process.env["SLIDE_STUDIO_PASSWORD"] = "hunter2hunter2";
  try {
    app = await buildApp({ dataDir: directory, baseUrl: () => "http://127.0.0.1:4173" });
    expect(app.authMode).toBe("required");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "hunter2hunter2" },
      headers,
    });
    expect(response.statusCode).toBe(204);
  } finally {
    if (saved === undefined) delete process.env["SLIDE_STUDIO_PASSWORD"];
    else process.env["SLIDE_STUDIO_PASSWORD"] = saved;
  }
});

it("prefers an explicit password option over the environment variable", async () => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-env-"));
  const saved = process.env["SLIDE_STUDIO_PASSWORD"];
  process.env["SLIDE_STUDIO_PASSWORD"] = "env-password-12";
  try {
    app = await buildApp({
      dataDir: directory,
      baseUrl: () => "http://127.0.0.1:4173",
      password: "option-password-12",
    });
    expect(app.authMode).toBe("required");
    const viaOption = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "option-password-12" },
      headers,
    });
    expect(viaOption.statusCode).toBe(204);
  } finally {
    if (saved === undefined) delete process.env["SLIDE_STUDIO_PASSWORD"];
    else process.env["SLIDE_STUDIO_PASSWORD"] = saved;
  }
});

it("stays in open mode when neither the option nor the environment set a password", async () => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-env-"));
  const saved = process.env["SLIDE_STUDIO_PASSWORD"];
  delete process.env["SLIDE_STUDIO_PASSWORD"];
  try {
    app = await buildApp({ dataDir: directory, baseUrl: () => "http://127.0.0.1:4173" });
    expect(app.authMode).toBe("open");
  } finally {
    if (saved === undefined) delete process.env["SLIDE_STUDIO_PASSWORD"];
    else process.env["SLIDE_STUDIO_PASSWORD"] = saved;
  }
});

it("refuses to build on a public bind when no password is set", async () => {
  // The interlock for the whole deployment: a container binds 0.0.0.0, so
  // without this a misconfigured deploy is an open editor on the internet.
  // Unit-testing resolveAuthMode is not enough — the throw has to survive
  // every layer between it and the caller.
  directory = mkdtempSync(join(tmpdir(), "slide-studio-env-"));
  const saved = process.env["SLIDE_STUDIO_PASSWORD"];
  delete process.env["SLIDE_STUDIO_PASSWORD"];
  try {
    for (const bindHost of ["0.0.0.0", "::", "192.168.1.20"]) {
      await expect(
        buildApp({
          dataDir: directory,
          baseUrl: () => "http://127.0.0.1:4173",
          bindHost,
        }),
      ).rejects.toThrow(/SLIDE_STUDIO_PASSWORD/);
    }
  } finally {
    if (saved === undefined) delete process.env["SLIDE_STUDIO_PASSWORD"];
    else process.env["SLIDE_STUDIO_PASSWORD"] = saved;
  }
});

it("builds on a public bind once a password is set", async () => {
  directory = mkdtempSync(join(tmpdir(), "slide-studio-env-"));
  app = await buildApp({
    dataDir: directory,
    baseUrl: () => "http://127.0.0.1:4173",
    bindHost: "0.0.0.0",
    password: "a-real-long-password",
  });
  expect(app.authMode).toBe("required");
});
