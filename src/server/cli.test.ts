import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { bannerLines, parseFlags, publicUrl, startServer } from "./cli.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("defaults to port 4173 on loopback", () => {
  expect(parseFlags([])).toMatchObject({
    port: 4173,
    host: "127.0.0.1",
    dataDir: join(homedir(), ".slide-studio"),
  });
});

it("reads --port, --host, and --data", () => {
  expect(
    parseFlags(["--port", "5000", "--host", "0.0.0.0", "--data", "/tmp/x"]),
  ).toMatchObject({
    port: 5000,
    host: "0.0.0.0",
    dataDir: "/tmp/x",
  });
});

it("reads the same flags written with an equals sign", () => {
  expect(parseFlags(["--port=5000", "--host=0.0.0.0", "--data=/tmp/x"])).toMatchObject({
    port: 5000,
    host: "0.0.0.0",
    dataDir: "/tmp/x",
  });
});

it("collects repeated --allowed-host flags", () => {
  expect(
    parseFlags(["--allowed-host", "a.local", "--allowed-host", "b.local"]).allowedHosts,
  ).toEqual(expect.arrayContaining(["a.local", "b.local"]));
});

it("keeps localhost in the allowed hosts and adds the one being served", () => {
  expect(parseFlags([]).allowedHosts).toEqual(["localhost", "127.0.0.1"]);
  // A wildcard bind is reached by a name the machine answers to, so the public
  // name is localhost and the list holds it once.
  expect(parseFlags(["--host", "0.0.0.0"]).allowedHosts).toEqual(["localhost"]);
  expect(
    parseFlags(["--host", "Studio.local", "--allowed-host", "STUDIO.local"]).allowedHosts,
  ).toEqual(["localhost", "studio.local"]);
});

it("reads SLIDE_STUDIO_PORT and SLIDE_STUDIO_DATA from the environment", () => {
  vi.stubEnv("SLIDE_STUDIO_PORT", "5100");
  vi.stubEnv("SLIDE_STUDIO_DATA", "/tmp/from-env");
  expect(parseFlags([])).toMatchObject({ port: 5100, dataDir: "/tmp/from-env" });
});

it("prefers a flag over the environment", () => {
  vi.stubEnv("SLIDE_STUDIO_PORT", "5100");
  vi.stubEnv("SLIDE_STUDIO_DATA", "/tmp/from-env");
  expect(parseFlags(["--port", "6000", "--data", "/tmp/from-flag"])).toMatchObject({
    port: 6000,
    dataDir: "/tmp/from-flag",
  });
});

it("falls back to the default port when the environment holds nonsense", () => {
  vi.stubEnv("SLIDE_STUDIO_PORT", "not-a-port");
  expect(parseFlags([]).port).toBe(4173);
});

it("says which flag is wrong rather than listening on a random port", () => {
  expect(() => parseFlags(["--port", "not-a-port"])).toThrow(
    /--port needs a whole number/,
  );
  expect(() => parseFlags(["--port", "70000"])).toThrow(/--port needs a whole number/);
  expect(() => parseFlags(["--data"])).toThrow(/--data needs a value/);
  expect(() => parseFlags(["--host="])).toThrow(/--host needs a value/);
});

it("ignores an argument that names no flag", () => {
  expect(parseFlags(["--colour", "blue", "extra"])).toMatchObject({
    port: 4173,
    host: "127.0.0.1",
  });
});

it("prints the URL, the endpoint and the data directory", () => {
  const lines = bannerLines(parseFlags(["--data", "/tmp/x"]), "open");
  expect(lines).toEqual([
    "Slide Studio is running at http://127.0.0.1:4173",
    "MCP endpoint: http://127.0.0.1:4173/mcp",
    "Data directory: /tmp/x",
    "No password set, so this server trusts anyone who can reach it.",
  ]);
});

it("tells a signed-in server apart from an open one", () => {
  const lines = bannerLines(
    parseFlags(["--host", "0.0.0.0", "--data", "/tmp/x"]),
    "required",
  );
  expect(lines).toEqual([
    "Slide Studio is running at http://localhost:4173",
    "MCP endpoint: http://localhost:4173/mcp",
    "Data directory: /tmp/x",
    "Sign in with your password. Agents need a token from Settings.",
  ]);
});

it("reads the new flags in both spellings", () => {
  expect(parseFlags(["--trust-proxy"]).trustProxy).toBe(true);
  expect(parseFlags([]).trustProxy).toBe(false);
  expect(parseFlags(["--public-url", "https://s.example.com"]).publicUrl).toBe(
    "https://s.example.com",
  );
  expect(parseFlags(["--public-url=https://s.example.com"]).publicUrl).toBe(
    "https://s.example.com",
  );
  expect(parseFlags(["--reset-password", "a-much-longer-one"]).resetPassword).toBe(
    "a-much-longer-one",
  );
});

it("reads the new environment variables", () => {
  process.env["SLIDE_STUDIO_TRUST_PROXY"] = "1";
  process.env["SLIDE_STUDIO_PUBLIC_URL"] = "https://env.example.com";
  try {
    expect(parseFlags([]).trustProxy).toBe(true);
    expect(parseFlags([]).publicUrl).toBe("https://env.example.com");
  } finally {
    delete process.env["SLIDE_STUDIO_TRUST_PROXY"];
    delete process.env["SLIDE_STUDIO_PUBLIC_URL"];
  }
});

it("prefers an explicit public URL over the bind address", () => {
  expect(publicUrl({ ...parseFlags([]), publicUrl: "https://s.example.com" })).toBe(
    "https://s.example.com",
  );
});

it("serves the API and the MCP endpoint once started", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "slide-studio-cli-"));
  const app = await startServer({ ...parseFlags(["--data", dataDir]), port: 0 });
  try {
    const address = app.addresses()[0];
    if (!address) throw new Error("The server is not listening.");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/api/health`);
    expect(await health.json()).toEqual({ ok: true, name: "slide-studio" });

    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // The endpoint is there and speaking JSON-RPC: an uninitialised session is
    // its own answer, not a 404.
    expect(mcp.status).not.toBe(404);
    expect(await mcp.text()).toContain("jsonrpc");
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
