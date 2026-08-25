/*
 * A minimal ZIP writer, store-only. Ported from the root zip.js, which this
 * replaces.
 *
 * Nothing is compressed. Every entry is a PNG, PNG payloads are already
 * deflated, so deflating them a second time costs time and saves nothing.
 *
 * The port changes the shape of the call and none of the bytes. zip.js took
 * Blobs and was therefore async; this takes bytes and is not, so the archive is
 * a pure function of its input and a test can read it back without awaiting.
 */

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One file in the archive. The name is written as UTF-8, whatever it holds. */
export type ZipEntry = {
  name: string;
  data: Uint8Array;
};

type DosStamp = { time: number; date: number };

/** MS-DOS timestamps hold two-second resolution and no timezone. */
function dosTimestamp(date: Date): DosStamp {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function localHeader(
  name: Uint8Array,
  crc: number,
  size: number,
  stamp: DosStamp,
): Uint8Array {
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  // Bit 11 marks the filename as UTF-8 rather than CP437.
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}

function centralHeader(
  name: Uint8Array,
  crc: number,
  size: number,
  stamp: DosStamp,
  offset: number,
): Uint8Array {
  const header = new Uint8Array(46 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  header.set(name, 46);
  return header;
}

function endOfCentralDirectory(
  count: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return end;
}

/**
 * Packs every entry into one archive: a local header and the stored bytes for
 * each, then a central directory, then the end-of-central-directory record.
 *
 * `at` exists so a test can read the MS-DOS timestamp back. zip.js called
 * `new Date()` inside the writer, which left the one field no test could pin.
 *
 * The buffer is named in the return type because a Blob refuses an array over a
 * SharedArrayBuffer, which is what a bare Uint8Array might be backed by.
 */
export function buildZip(
  entries: ZipEntry[],
  at: Date = new Date(),
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stamp = dosTimestamp(at);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const header = localHeader(name, crc, entry.data.length, stamp);
    parts.push(header, entry.data);
    central.push(centralHeader(name, crc, entry.data.length, stamp, offset));
    offset += header.length + entry.data.length;
  }

  const centralSize = central.reduce((total, header) => total + header.length, 0);
  const end = endOfCentralDirectory(entries.length, centralSize, offset);
  const all = [...parts, ...central, end];
  const archive = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of all) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

/** The same archive, wrapped for a download or a share. */
export function zipBlob(entries: ZipEntry[], at?: Date): Blob {
  return new Blob([buildZip(entries, at)], { type: "application/zip" });
}
