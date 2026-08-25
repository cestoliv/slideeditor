import { expect, it } from "vitest";
import { buildZip, zipBlob } from "./zip.js";

/*
 * The ZIP writer, tested against the format rather than against itself.
 *
 * These assertions come from src/server/zip.test.ts, which read the root zip.js
 * through `new Function` because it predates the TypeScript tree. That file is
 * deleted, and this one replaces it.
 *
 * The old test handed the archive to python3's zipfile, which validated every
 * CRC and honoured the UTF-8 filename flag. That check cannot move here:
 * tsconfig.web.json compiles src/web with `types: []`, so a node:child_process
 * import fails `npm run check` even though vitest runs this file under node.
 * Three things stand in for it. The reader below walks the central directory
 * rather than trusting the writer's own offsets, crc32Bitwise recomputes every
 * checksum without the writer's lookup table, and one entry carries the
 * standard "123456789" vector whose CRC32 is published as 0xCBF43926.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/**
 * CRC32 the long way round, one bit at a time.
 *
 * zip.ts builds a 256-entry table and folds a byte at a time. Recomputing the
 * same way here would only prove the table is self-consistent, so this walks
 * the polynomial directly and agrees with it only if both are right.
 */
function crc32Bitwise(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ReadEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  data: Uint8Array;
};

/**
 * An independent reader, entered from the end of the archive the way every real
 * unzipper enters one. It trusts nothing the writer put in a local header until
 * the central directory has pointed it there.
 */
function readZip(archive: Uint8Array): ReadEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = archive.length - 22;
  expect(view.getUint32(endOffset, true), "the archive ends with an EOCD record").toBe(
    0x06054b50,
  );
  const count = view.getUint16(endOffset + 10, true);
  expect(
    view.getUint16(endOffset + 8, true),
    "this disk holds every entry the archive does",
  ).toBe(count);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  expect(centralOffset + centralSize, "the central directory abuts the EOCD").toBe(
    endOffset,
  );

  const entries: ReadEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true), "each central header is signed").toBe(
      0x02014b50,
    );
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(archive.slice(cursor + 46, cursor + 46 + nameLength));

    expect(view.getUint32(localOffset, true), "the local header is signed").toBe(
      0x04034b50,
    );
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = decoder.decode(
      archive.slice(localOffset + 30, localOffset + 30 + localNameLength),
    );
    expect(localName, "both headers name the same entry").toBe(name);
    expect(
      view.getUint16(localOffset + 6, true),
      "both headers carry the same flags",
    ).toBe(flags);
    expect(view.getUint32(localOffset + 14, true), "both headers agree on the CRC").toBe(
      crc,
    );
    /*
     * Both size fields as well, and not because a reader entering from the
     * central directory would notice. It would not: an archive whose local
     * header claims zero bytes opens fine in any such reader and extracts
     * nothing in a streaming one, ZipInputStream and `unzip` from a pipe
     * included. Only a check that reads both copies sees it.
     */
    expect(
      view.getUint32(localOffset + 18, true),
      "both headers agree on the compressed size",
    ).toBe(compressedSize);
    expect(
      view.getUint32(localOffset + 22, true),
      "both headers agree on the stored size",
    ).toBe(uncompressedSize);

    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      data: archive.slice(start, start + compressedSize),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor, "the walk consumes the whole central directory").toBe(endOffset);
  return entries;
}

it("writes a readable local file header", () => {
  const zip = buildZip([{ name: "a.png", data: new Uint8Array([1, 2, 3]) }]);
  expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
});

it("ends with the end-of-central-directory signature", () => {
  const zip = buildZip([{ name: "a.png", data: new Uint8Array([1, 2, 3]) }]);
  expect(Array.from(zip.slice(-22, -18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
});

it("records the entry count in the central directory", () => {
  const zip = buildZip([
    { name: "01-first.png", data: bytes("first payload") },
    { name: "02-second.png", data: bytes("second payload") },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2);
  expect(readZip(zip).map((entry) => entry.name)).toEqual([
    "01-first.png",
    "02-second.png",
  ]);
});

it("computes the CRC32 of the stored bytes", () => {
  // The published check value for CRC-32/ISO-HDLC over the nine ASCII digits.
  const zip = buildZip([{ name: "check.bin", data: bytes("123456789") }]);
  const [entry] = readZip(zip);
  expect(entry?.crc).toBe(0xcbf43926);
});

it("checksums every entry, whatever its bytes", () => {
  const payloads = [
    new Uint8Array(),
    new Uint8Array([0]),
    bytes("first payload"),
    new Uint8Array(1024).map((_value, index) => (index * 37) % 256),
  ];
  const zip = buildZip(
    payloads.map((data, index) => ({ name: `${String(index)}.bin`, data })),
  );
  const read = readZip(zip);
  expect(read).toHaveLength(payloads.length);
  read.forEach((entry, index) => {
    const payload = payloads[index] ?? new Uint8Array();
    expect(entry.crc, `entry ${String(index)} carries its own checksum`).toBe(
      crc32Bitwise(payload),
    );
    expect(Array.from(entry.data), `entry ${String(index)} stores its own bytes`).toEqual(
      Array.from(payload),
    );
  });
});

it("writes a UTF-8 filename and sets the flag", () => {
  const name = "02-project-Ünïcode ✓.png";
  const zip = buildZip([{ name, data: bytes("second payload") }]);
  const [entry] = readZip(zip);
  expect(entry?.name).toBe(name);
  // Bit 11 of the general purpose flags is what tells a reader the name is
  // UTF-8 rather than CP437.
  expect((entry?.flags ?? 0) & 0x0800).toBe(0x0800);

  const encoded = encoder.encode(name);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(view.getUint16(26, true), "the header counts bytes, not characters").toBe(
    encoded.length,
  );
  expect(encoded.length).toBeGreaterThan([...name].length);
  expect(Array.from(zip.slice(30, 30 + encoded.length))).toEqual(Array.from(encoded));
});

it("stores entries rather than deflating them", () => {
  const zip = buildZip([
    { name: "a.bin", data: bytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") },
    { name: "b.bin", data: bytes("bbbb") },
  ]);
  for (const entry of readZip(zip)) {
    expect(entry.method, "PNG payloads are already deflated").toBe(0);
    expect(entry.compressedSize).toBe(entry.uncompressedSize);
  }
});

it("points each central header at its own local header", () => {
  const payloads = [bytes("one"), bytes("two-two"), bytes("three-three-three")];
  const zip = buildZip(
    payloads.map((data, index) => ({ name: `slide-${String(index)}.png`, data })),
  );
  const read = readZip(zip);
  let expected = 0;
  read.forEach((entry, index) => {
    expect(entry.localOffset, `entry ${String(index)} sits where it is indexed`).toBe(
      expected,
    );
    expected += 30 + encoder.encode(entry.name).length + entry.uncompressedSize;
  });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(
    view.getUint32(zip.length - 22 + 16, true),
    "the payloads run up to the central directory with no gap",
  ).toBe(expected);
});

it("writes an MS-DOS timestamp at two-second resolution", () => {
  // The format holds no timezone, so the fields are the local clock's own.
  const at = new Date(2024, 4, 17, 13, 45, 31);
  const zip = buildZip([{ name: "a.png", data: bytes("x") }], at);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const time = view.getUint16(10, true);
  const date = view.getUint16(12, true);
  expect(time >> 11, "hours").toBe(13);
  expect((time >> 5) & 0x3f, "minutes").toBe(45);
  expect((time & 0x1f) * 2, "seconds, rounded down to the nearest two").toBe(30);
  expect(((date >> 9) & 0x7f) + 1980, "year").toBe(2024);
  expect((date >> 5) & 0x0f, "month").toBe(5);
  expect(date & 0x1f, "day").toBe(17);
});

it("clamps a pre-1980 timestamp, which the format cannot express", () => {
  const zip = buildZip([{ name: "a.png", data: bytes("x") }], new Date(1971, 0, 1));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(((view.getUint16(12, true) >> 9) & 0x7f) + 1980).toBe(1980);
});

it("writes a valid empty archive", () => {
  const zip = buildZip([]);
  expect(zip.length, "an empty archive is just the end-of-central-directory record").toBe(
    22,
  );
  expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  expect(readZip(zip)).toEqual([]);
});

it("hands the bytes over as a ZIP blob", async () => {
  const blob = zipBlob([{ name: "a.png", data: bytes("payload") }]);
  expect(blob.type).toBe("application/zip");
  const read = readZip(new Uint8Array(await blob.arrayBuffer()));
  expect(read.map((entry) => entry.name)).toEqual(["a.png"]);
  expect(decoder.decode(read[0]?.data)).toBe("payload");
});
