import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { AuthMode } from "./auth/mode.js";
import { CredentialStore } from "./auth/credentials.js";
import { SessionStore } from "./auth/sessions.js";
import { dataPaths, openDb } from "./db/open.js";

export interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  allowedHosts: string[];
  trustProxy: boolean;
  publicUrl: string | null;
  resetPassword: string | null;
}

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
// A wildcard bind answers to every name the machine has, and the one a person
// types is localhost (server/main.mjs:64).
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * The flags server/main.mjs:33-53 accepted, in both the `--flag value` and the
 * `--flag=value` spelling. A flag beats the environment, and the environment
 * beats the default.
 */
export function parseFlags(argv: string[]): CliOptions {
  // Never package-relative: run through npx and that directory is a throwaway
  // cache, so the library and every slideshow would vanish between runs.
  let host = DEFAULT_HOST;
  let port = envPort();
  let dataDir = process.env["SLIDE_STUDIO_DATA"] || join(homedir(), ".slide-studio");
  const allowedHosts: string[] = [];
  let trustProxy = process.env["SLIDE_STUDIO_TRUST_PROXY"] === "1";
  let publicUrlOverride = process.env["SLIDE_STUDIO_PUBLIC_URL"] || null;
  let resetPassword: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    const value = inline ?? argv[index + 1];

    if (flag === "--host") host = requireValue(flag, value);
    else if (flag === "--port") port = wholeNumber(flag, requireValue(flag, value));
    else if (flag === "--data") dataDir = requireValue(flag, value);
    else if (flag === "--allowed-host")
      allowedHosts.push(requireValue(flag, value).toLowerCase());
    else if (flag === "--trust-proxy") {
      trustProxy = true;
      // A bare switch consumes no value, so the index must not advance.
      continue;
    } else if (flag === "--public-url") publicUrlOverride = requireValue(flag, value);
    else if (flag === "--reset-password") resetPassword = requireValue(flag, value);
    // An argument naming no flag is skipped, and so is the value it may be.
    else continue;
    if (inline === undefined) index += 1;
  }

  return {
    port,
    host,
    dataDir,
    allowedHosts: hostList(host, allowedHosts),
    trustProxy,
    publicUrl: publicUrlOverride,
    resetPassword,
  };
}

/** The name a person types to reach this server (server/main.mjs:64). */
export function publicHost(host: string): string {
  return WILDCARD_HOSTS.has(host) ? "localhost" : host;
}

/**
 * The base every URL the server hands out is built from (server/main.mjs:65).
 * An explicit override wins over the bind address, which is the only way a
 * server behind a reverse proxy can advertise the name the proxy answers to
 * rather than the loopback address it actually listens on.
 */
export function publicUrl(options: CliOptions): string {
  if (options.publicUrl) return options.publicUrl.replace(/\/+$/, "");
  return `http://${publicHost(options.host)}:${options.port}`;
}

/**
 * What the old entry printed on startup (server/main.mjs:157-164), adapted for
 * password auth: an open server has no credential to hand out, so it warns
 * instead of printing a token.
 */
export function bannerLines(options: CliOptions, mode: AuthMode): string[] {
  const base = publicUrl(options);
  const lines = [
    `Slide Studio is running at ${base}`,
    `MCP endpoint: ${base}/mcp`,
    `Data directory: ${options.dataDir}`,
  ];
  lines.push(
    mode === "open"
      ? "No password set, so this server trusts anyone who can reach it."
      : "Sign in with your password. Agents need a token from Settings.",
  );
  return lines;
}

/** The whole server on a socket. Returned so a caller can close it again. */
export async function startServer(options: CliOptions): Promise<FastifyInstance> {
  const base = publicUrl(options);
  const app = await buildApp({
    dataDir: options.dataDir,
    allowedHosts: options.allowedHosts,
    baseUrl: () => base,
    trustProxy: options.trustProxy,
    bindHost: options.host,
  });
  await app.listen({ port: options.port, host: options.host });
  return app;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseFlags(argv);
  if (options.resetPassword !== null) {
    resetPassword(options.dataDir, options.resetPassword);
    return;
  }
  const app = await startServer(options);
  // Fastify's default logger is a no-op, so the banner goes to the console.
  for (const line of bannerLines(options, app.authMode)) console.log(line);
}

/**
 * The way back in for someone who forgot the password. It needs shell access
 * to the data directory, which is the right bar for a recovery path, and it
 * never opens a socket, so it works even against a server that refuses to
 * start (server/main.mjs has no equivalent: the old design had no password).
 */
function resetPassword(dataDir: string, password: string): void {
  if (password.length < 12) {
    throw new Error("A password needs at least 12 characters.");
  }
  const paths = dataPaths(dataDir);
  const db = openDb(paths.database, paths.token);
  try {
    new CredentialStore(db).setPassword(password);
    // Every browser signed in under the old password loses its session.
    new SessionStore(db).revokeAll();
  } finally {
    db.close();
  }
  console.log(`Password updated for ${dataDir}. Every existing session is signed out.`);
}

/**
 * The old parse read the environment through `Number(...) || 4173`, so anything
 * unreadable there fell back rather than stopping a server that was probably
 * started by a script.
 */
function envPort(): number {
  return Number(process.env["SLIDE_STUDIO_PORT"]) || DEFAULT_PORT;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

/**
 * A person typed this flag, so a value that cannot be a port stops the server
 * rather than silently landing on a random one, which is what Number(NaN) gave
 * the old CLI.
 */
function wholeNumber(flag: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${flag} needs a whole number between 0 and 65535, not ${value}.`);
  }
  return port;
}

/** Ported from server/main.mjs:66, which deduplicated the same three sources. */
function hostList(host: string, extra: string[]): string[] {
  return [...new Set(["localhost", publicHost(host).toLowerCase(), ...extra])];
}
