import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadZipWriter() {
  const scope = {};
  const source = readFileSync(join(root, "zip.js"), "utf8");
  new Function("window", source)(scope);
  return scope.createZipBlob;
}

test("writes an archive real tools can read", async () => {
  const createZipBlob = loadZipWriter();
  const blob = await createZipBlob([
    { name: "01-project-first.png", blob: new Blob([Buffer.from("first payload")]) },
    { name: "02-project-Ünïcode ✓.png", blob: new Blob([Buffer.from("second payload")]) },
  ]);
  assert.equal(blob.type, "application/zip");

  const directory = mkdtempSync(join(tmpdir(), "slide-studio-zip-"));
  const file = join(directory, "out.zip");
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  try {
    // Python's zipfile validates CRCs and honours the UTF-8 filename flag.
    const report = execFileSync("python3", ["-c", `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(file)})
print(json.dumps({
  "bad": z.testzip(),
  "names": z.namelist(),
  "methods": [i.compress_type for i in z.infolist()],
  "first": z.read(z.namelist()[0]).decode(),
}))
`]).toString();
    const result = JSON.parse(report);
    assert.equal(result.bad, null, "no entry may fail its CRC check");
    assert.deepEqual(result.names, ["01-project-first.png", "02-project-Ünïcode ✓.png"]);
    assert.deepEqual(result.methods, [0, 0], "entries must be stored, not deflated");
    assert.equal(result.first, "first payload");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes a valid empty archive", async () => {
  const createZipBlob = loadZipWriter();
  const blob = await createZipBlob([]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes.length, 22, "an empty archive is just the end-of-central-directory record");
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x05, 0x06]);
});
