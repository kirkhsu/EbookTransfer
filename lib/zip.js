import { deflateRawSync, inflateRawSync } from "node:zlib";

// Precompute CRC-32 table (IEEE 802.3 polynomial 0xEDB88320)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosTime, dosDate };
}

/**
 * Minimal, EPUB-compliant ZIP archive builder (zero external dependencies).
 * Supports STORE (0) and DEFLATE (8), UTF-8 filenames, and strict ordering
 * so EPUB's uncompressed `mimetype` entry is placed first with no extra field.
 */
export class ZipBuilder {
  constructor() {
    this.entries = [];
  }

  /**
   * Add a file entry to the ZIP archive.
   * @param {string} name Forward-slash relative path inside the archive
   * @param {Buffer|Uint8Array|string} content File contents
   * @param {{ compress?: boolean, date?: Date }} [options]
   */
  addFile(name, content, options = {}) {
    const data =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.isBuffer(content)
          ? content
          : Buffer.from(content);
    const compress = options.compress !== false;
    const { dosTime, dosDate } = toDosTimeDate(options.date);
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (compress && data.length > 0) {
      const deflated = deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    this.entries.push({
      nameBuf,
      method,
      crc,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      dosTime,
      dosDate,
      payload,
    });
  }

  /**
   * Serialize the entire ZIP archive to a Buffer.
   * @returns {Buffer}
   */
  toBuffer() {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of this.entries) {
      // Bit 11 = UTF-8 filename encoding (skip for `mimetype` if pure ASCII)
      const isAscii = entry.nameBuf.every((b) => b < 0x80);
      const flags = isAscii ? 0 : 0x0800;

      // Local File Header (30 bytes + filename)
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
      localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
      localHeader.writeUInt16LE(flags, 6); // General purpose bit flag
      localHeader.writeUInt16LE(entry.method, 8); // Compression method
      localHeader.writeUInt16LE(entry.dosTime, 10);
      localHeader.writeUInt16LE(entry.dosDate, 12);
      localHeader.writeUInt32LE(entry.crc, 14);
      localHeader.writeUInt32LE(entry.compressedSize, 18);
      localHeader.writeUInt32LE(entry.uncompressedSize, 22);
      localHeader.writeUInt16LE(entry.nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28); // Extra field length = 0

      localParts.push(localHeader, entry.nameBuf, entry.payload);

      // Central Directory Header (46 bytes + filename)
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
      centralHeader.writeUInt16LE(20, 4); // Version made by
      centralHeader.writeUInt16LE(20, 6); // Version needed to extract
      centralHeader.writeUInt16LE(flags, 8);
      centralHeader.writeUInt16LE(entry.method, 10);
      centralHeader.writeUInt16LE(entry.dosTime, 12);
      centralHeader.writeUInt16LE(entry.dosDate, 14);
      centralHeader.writeUInt32LE(entry.crc, 16);
      centralHeader.writeUInt32LE(entry.compressedSize, 20);
      centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
      centralHeader.writeUInt16LE(entry.nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30); // Extra field length
      centralHeader.writeUInt16LE(0, 32); // File comment length
      centralHeader.writeUInt16LE(0, 34); // Disk number start
      centralHeader.writeUInt16LE(0, 36); // Internal file attributes
      centralHeader.writeUInt32LE(0, 38); // External file attributes
      centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

      centralParts.push(centralHeader, entry.nameBuf);
      offset += localHeader.length + entry.nameBuf.length + entry.payload.length;
    }

    const centralDirOffset = offset;
    const centralDirBuf = Buffer.concat(centralParts);

    // End of Central Directory Record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // Number of this disk
    eocd.writeUInt16LE(0, 6); // Disk where central directory starts
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralDirBuf.length, 12);
    eocd.writeUInt32LE(centralDirOffset, 16);
    eocd.writeUInt16LE(0, 20); // Comment length

    return Buffer.concat([...localParts, centralDirBuf, eocd]);
  }
}

/**
 * Parse an EPUB/ZIP archive Buffer and return a Map of entries.
 * Zero-dependency pure Node.js ZIP parser.
 * @param {Buffer} buffer
 * @returns {Map<string, { name: string, method: number, compressedSize: number, uncompressedSize: number, data: Buffer }>}
 */
export function parseZip(buffer) {
  const entries = new Map();

  // Search backward for End of Central Directory (EOCD, 0x06054b50)
  let eocdOffset = -1;
  const maxSearch = Math.min(buffer.length, 65535 + 22);
  const startSearch = buffer.length - maxSearch;
  for (let i = buffer.length - 22; i >= startSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("無效的 ZIP/EPUB 檔案：找不到 End of Central Directory 標頭");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`無效的 Central Directory 標頭（偏移量 ${offset}）`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    const nameBuf = buffer.subarray(offset + 46, offset + 46 + nameLen);
    const name = nameBuf.toString("utf8");

    // Read local header to locate payload
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`無效的 Local File Header 標頭（偏移量 ${localHeaderOffset}）`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

    const rawData = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) {
      data = rawData;
    } else if (method === 8) {
      data = inflateRawSync(rawData);
    } else {
      throw new Error(`不支援的 ZIP 壓縮格式 (${method})：${name}`);
    }

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      data,
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
