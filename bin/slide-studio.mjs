#!/usr/bin/env node
const REQUIRED_NODE = 22;

const major = Number(process.versions.node.split(".")[0]);
if (major < REQUIRED_NODE) {
  console.error(
    `Slide Studio needs Node ${REQUIRED_NODE} or newer for node:sqlite. This is Node ${process.versions.node}.`,
  );
  process.exit(1);
}

// Suppress the node:sqlite experimental warning without hiding real warnings.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (name === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return emit.call(process, warning, ...rest);
};

const { main } = await import("../dist/server/server/cli.js");

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
