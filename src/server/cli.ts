import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

export interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  allowedHosts: string[];
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
    // An argument naming no flag is skipped, and so is the value it may be.
    else continue;
    if (inline === undefined) index += 1;
  }

  return { port, host, dataDir, allowedHosts: hostList(host, allowedHosts) };
}

/** The name a person types to reach this server (server/main.mjs:64). */
export function publicHost(host: string): string {
  return WILDCARD_HOSTS.has(host) ? "localhost" : host;
}

/** The base every URL the server hands out is built from (server/main.mjs:65). */
export function publicUrl(options: CliOptions): string {
  return `http://${publicHost(options.host)}:${options.port}`;
}

/**
 * What the old entry printed on startup (server/main.mjs:157-164). The token
 * lines are for the person who opened this server to a network, so they only
 * appear when the bind is not loopback.
 */
export function bannerLines(options: CliOptions, token: string): string[] {
  const base = publicUrl(options);
  const lines = [
    `Slide Studio is running at ${base}`,
    `MCP endpoint: ${base}/mcp`,
    `Data directory: ${options.dataDir}`,
  ];
  if (options.host !== DEFAULT_HOST) {
    lines.push(`Remote access token: ${token}`);
    lines.push("Requests from other machines must send: Authorization: Bearer <token>");
  }
  return lines;
}

/** The whole server on a socket. Returned so a caller can close it again. */
export async function startServer(options: CliOptions): Promise<FastifyInstance> {
  const base = publicUrl(options);
  const app = await buildApp({
    dataDir: options.dataDir,
    allowedHosts: options.allowedHosts,
    baseUrl: () => base,
  });
  await app.listen({ port: options.port, host: options.host });
  return app;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseFlags(argv);
  const app = await startServer(options);
  // Fastify's default logger is a no-op, so the banner goes to the console.
  for (const line of bannerLines(options, app.token)) console.log(line);
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
