import { brotliDecompressSync } from "node:zlib";

/** The tags WOFF2 names by index, in the order of its known-tag table. */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm",
  "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern",
  "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC",
  "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty",
  "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
]; // prettier-ignore

/**
 * Unpacks a WOFF2 file into a plain sfnt that readFontMetrics can read, or
 * returns null for anything else. A Google face is self-hosted as WOFF2.
 *
 * Every table but a transformed glyf and loca comes through, since their
 * transform rebuilds outlines no measurement reads. A transformed hmtx keeps
 * its advance widths and loses its side bearings, which no width depends on
 * either.
 */
export function woff2ToSfnt(bytes: Uint8Array): Uint8Array | null {
  try {
    return unpack(bytes);
  } catch {
    // A truncated or corrupt file reads past its end or fails to inflate.
    return null;
  }
}

function unpack(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 48 || view.getUint32(0) !== 0x774f4632) return null;
  const flavor = view.getUint32(4);
  // A collection has a directory of its own, and no Google face is one.
  if (flavor === 0x74746366) return null;

  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = view.getUint8(at++);
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("A WOFF2 length runs past five bytes.");
  };
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  for (let index = 0; index < view.getUint16(12); index++) {
    const flags = view.getUint8(at++);
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = String.fromCharCode(...bytes.subarray(at, at + 4));
      at += 4;
    }
    const version = flags >> 6;
    const origLength = base128();
    // glyf and loca are transformed at version 0, every other table above it.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    const length = transformed ? base128() : origLength;
    entries.push({ tag: tag ?? "", length, transformed });
  }

  const stream = brotliDecompressSync(bytes.subarray(at, at + view.getUint32(20)));

  const tables = new Map<string, Uint8Array>();
  let offset = 0;
  for (const entry of entries) {
    tables.set(entry.tag, stream.subarray(offset, offset + entry.length));
    offset += entry.length;
  }
  const kept = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const data = tables.get(entry.tag);
    if (data === undefined) continue;
    if (!entry.transformed) kept.set(entry.tag, data);
    else if (entry.tag === "hmtx") {
      const hhea = tables.get("hhea");
      if (hhea === undefined) return null;
      kept.set(
        "hmtx",
        advancesOnly(data, new DataView(hhea.buffer, hhea.byteOffset).getUint16(34)),
      );
    }
  }
  return sfnt(flavor, kept);
}

/** A transformed hmtx (version 1) rebuilt as metrics with zero side bearings. */
function advancesOnly(data: Uint8Array, count: number): Uint8Array {
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const table = new Uint8Array(4 * count);
  const target = new DataView(table.buffer);
  for (let index = 0; index < count; index++) {
    target.setUint16(4 * index, source.getUint16(1 + 2 * index));
  }
  return table;
}

/** An sfnt holding `tables`, each 4-byte aligned. Checksums stay zero: nothing here reads them. */
function sfnt(flavor: number, tables: Map<string, Uint8Array>): Uint8Array {
  const directory = 12 + 16 * tables.size;
  let size = directory;
  for (const data of tables.values()) size += Math.ceil(data.byteLength / 4) * 4;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, flavor);
  view.setUint16(4, tables.size);
  let record = 12;
  let offset = directory;
  for (const [tag, data] of tables) {
    for (let index = 0; index < 4; index++) out[record + index] = tag.charCodeAt(index);
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.byteLength);
    out.set(data, offset);
    record += 16;
    offset += Math.ceil(data.byteLength / 4) * 4;
  }
  return out;
}
