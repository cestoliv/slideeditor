/**
 * Minimal ZIP writer for the browser, store-only (no compression).
 * PNG payloads are already deflated, so compressing them again costs time and
 * saves nothing. Exposes window.createZipBlob(entries) where each entry is
 * { name, blob }.
 */
(() => {
  const CRC_TABLE = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC_TABLE[index] = value >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** MS-DOS timestamps hold two-second resolution and no timezone. */
  function dosTimestamp(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function localHeader(name, crc, size, stamp) {
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
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

  function centralHeader(name, crc, size, stamp, offset) {
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

  function endOfCentralDirectory(count, centralSize, centralOffset) {
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    return end;
  }

  async function createZipBlob(entries) {
    const encoder = new TextEncoder();
    const stamp = dosTimestamp(new Date());
    const body = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      const crc = crc32(bytes);
      const header = localHeader(name, crc, bytes.length, stamp);
      body.push(header, bytes);
      central.push(centralHeader(name, crc, bytes.length, stamp, offset));
      offset += header.length + bytes.length;
    }

    const centralSize = central.reduce((total, header) => total + header.length, 0);
    const end = endOfCentralDirectory(entries.length, centralSize, offset);
    return new Blob([...body, ...central, end], { type: "application/zip" });
  }

  window.createZipBlob = createZipBlob;
})();
