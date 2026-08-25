// A dependency-free USTAR writer/reader for the one case we need: regular
// files from a flat directory. This backs up the media directory before a
// filesystem-layout migration rewrites it, so a subtly wrong writer would
// make the backup worthless exactly when it is needed.

export interface TarEntry {
  name: string;
  body: Buffer;
}

const BLOCK_SIZE = 512;
const NAME_FIELD_LENGTH = 100;

function writeOctalField(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  // Octal, NUL terminated, left padded with zeros: "%0(length-1)o\0".
  const digits = value.toString(8).padStart(length - 1, "0");
  header.write(digits, offset, "ascii");
  header[offset + length - 1] = 0;
}

function readOctalField(header: Buffer, offset: number, length: number): number {
  const raw = header.toString("ascii", offset, offset + length);
  // Fields are NUL and/or space terminated; strip trailing junk before parsing.
  const digits = raw.replace(/[\0 ].*$/, "");
  return digits.length ? parseInt(digits, 8) : 0;
}

function buildHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, "ascii");
  writeOctalField(header, 100, 8, 0o644); // mode
  writeOctalField(header, 108, 8, 0); // uid
  writeOctalField(header, 116, 8, 0); // gid
  writeOctalField(header, 124, 12, size); // size
  writeOctalField(header, 136, 12, 0); // mtime
  header.write("        ", 148, "ascii"); // checksum field as eight spaces, for the sum below
  header[156] = "0".charCodeAt(0); // type flag: regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  header[148 + 6] = 0;
  header[148 + 7] = " ".charCodeAt(0);

  return header;
}

function padToBlock(length: number): number {
  const remainder = length % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

export function packTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, "ascii");
    if (nameBytes >= NAME_FIELD_LENGTH) {
      // A truncated name would silently restore to the wrong path, which is
      // worse than a refusal an operator can see.
      throw new Error(`tar entry name too long for USTAR header: ${entry.name}`);
    }
    chunks.push(buildHeader(entry.name, entry.body.length));
    chunks.push(entry.body);
    const padding = padToBlock(entry.body.length);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  // The archive ends with two zero blocks.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

export function unpackTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break; // zero block: end of archive

    const storedChecksum = readOctalField(header, 148, 8);
    const check = Buffer.from(header);
    check.write("        ", 148, "ascii");
    let computedChecksum = 0;
    for (const byte of check) computedChecksum += byte;
    if (computedChecksum !== storedChecksum) {
      throw new Error(`tar checksum mismatch at offset ${offset}: archive is corrupt`);
    }

    const nameEnd = header.indexOf(0, 0);
    const name = header.toString(
      "ascii",
      0,
      nameEnd === -1 ? NAME_FIELD_LENGTH : nameEnd,
    );
    const size = readOctalField(header, 124, 12);

    offset += BLOCK_SIZE;
    const body = Buffer.from(archive.subarray(offset, offset + size));
    entries.push({ name, body });
    offset += size + padToBlock(size);
  }

  return entries;
}
