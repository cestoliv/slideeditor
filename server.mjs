#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const REQUIRED_NODE = 22;

const major = Number(process.versions.node.split(".")[0]);
if (major < REQUIRED_NODE) {
  console.error(`Slide Studio needs Node ${REQUIRED_NODE} or newer for node:sqlite. This is Node ${process.versions.node}.`);
  process.exit(1);
}

// A fresh clone has no dependencies yet. Installing them here keeps `npm start`
// the only command anyone has to run. npx and a global install already have
// them, and their package directory is read-only, so skip it there.
const isCheckout = existsSync(join(root, ".git"));
if (isCheckout && !existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  console.log("Installing dependencies, one moment…");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) {
    console.error("\nThat install failed. Run `npm install` yourself, then `npm start` again.");
    process.exit(1);
  }
  console.log("");
}

// Suppress the node:sqlite experimental warning without hiding real warnings.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (name === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return emit.call(process, warning, ...rest);
};

const { start } = await import("./server/main.mjs");
start();
