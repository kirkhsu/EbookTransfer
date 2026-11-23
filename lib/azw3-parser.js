import { inflateSync } from "node:zlib";

const LOCALE_MAP = {
  0x0409: "en-US",
  0x0809: "en-GB",
  0x0009: "en",
  0x0804: "zh-CN",
  0x0404: "zh-TW",
  0x0c04: "zh-HK",
  0x0004: "zh",
  0x0411: "ja",
  0x0011: "ja",
  0x0412: "ko",
  0x0012: "ko",
  0x040c: "fr",
  0x0407: "de",
  0x040a: "es",
  0x0410: "it",
  0x0416: "pt-BR",
  0x0816: "pt",
  0x0419: "ru",
};

const NON_MEDIA_MAGICS = new Set([
  "INDX",
  "FDST",
  "FLIS",
  "FCIS",
  "DATP",
  "RESC",
  "CRES",
  "GESW",
  "BOUN",
  "CMET",
  "AUDI",
  "VIDE",
  "SRCS",
  "CONT",
  "KIND",
]);

function readVarIntForward(buf, pos) {
  let val = 0;
  let consumed = 0;
  while (pos + consumed < buf.length && consumed < 5) {
    const b = buf[pos + consumed++];
    val = (val << 7) | (b & 0x7f);
    if (b & 0x80) break;
  }
  return [val, consumed];
}

function readVarIntBackward(buf, end) {
  let val = 0;
  let shift = 0;
  let pos = end - 1;
  while (pos >= 0 && shift < 28) {
    const b = buf[pos--];
    val |= (b & 0x7f) << shift;
    shift += 7;
    if (b & 0x80) break;
  }
  return val;
}

function stripTrailingData(rec, extraFlags) {
  if (!extraFlags) return rec;
  let end = rec.length;
  for (let bit = 1; bit < 16; bit++) {
    if (extraFlags & (1 << bit)) {
      if (end <= 0) break;
      const size = readVarIntBackward(rec, end);
      end = Math.max(0, end - size);
    }
  }
  if ((extraFlags & 1) && end > 0) {
    const size = (rec[end - 1] & 0x03) + 1;
    end = Math.max(0, end - size);
  }
  return rec.subarray(0, end);
}

function decompressPalmDOC(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0) {
      out.push(0);
    } else if (c <= 8) {
      for (let j = 0; j < c && i < data.length; j++) {
        out.push(data[i++]);
      }
    } else if (c <= 0x7f) {
      out.push(c);
    } else if (c >= 0xc0) {
      out.push(0x20, c ^ 0x80);
    } else {
      if (i >= data.length) break;
      const next = data[i++];
      const pair = (c << 8) | next;
      const dist = (pair >> 3) & 0x07ff;
      const len = (pair & 0x07) + 3;
      for (let j = 0; j < len; j++) {
        out.push(out[out.length - dist] ?? 0);
      }
    }
  }
  return Buffer.from(out);
}

class HuffCdicDecoder {
  constructor(huffRec, cdicRecs) {
    if (huffRec.subarray(0, 4).toString("latin1") !== "HUFF") {
      throw new Error("Invalid HUFF header");
    }
    const off1 = huffRec.readUInt32BE(16);
    const off2 = huffRec.readUInt32BE(20);

    this.dict1 = new Array(256);
    for (let i = 0; i < 256; i++) {
      const v = huffRec.readUInt32BE(off1 + i * 4);
      this.dict1[i] = {
        codelen: v & 0x1f,
        term: (v & 0x80) !== 0,
        maxcode: v >>> 8,
      };
    }

    this.mincode = new Array(33).fill(0n);
    this.maxcode = new Array(33).fill(0n);
    for (let codelen = 1; codelen <= 32; codelen++) {
      const minv = BigInt(huffRec.readUInt32BE(off2 + (codelen - 1) * 8));
      const maxv = BigInt(huffRec.readUInt32BE(off2 + (codelen - 1) * 8 + 4));
      this.mincode[codelen] = minv << BigInt(32 - codelen);
      this.maxcode[codelen] =
        ((maxv + 1n) << BigInt(32 - codelen)) - 1n;
    }

    this.dictionary = [];
    for (const cdic of cdicRecs) {
      if (cdic.subarray(0, 4).toString("latin1") !== "CDIC") {
        throw new Error("Invalid CDIC header");
      }
      const phrases = cdic.readUInt32BE(8);
      const bits = cdic.readUInt32BE(12);
      const n = Math.min(1 << bits, phrases - this.dictionary.length);
      for (let i = 0; i < n; i++) {
        const off = cdic.readUInt16BE(16 + i * 2);
        const blen = cdic.readUInt16BE(16 + off);
        const slice = cdic.subarray(16 + off + 2, 16 + off + 2 + (blen & 0x7fff));
        const flag = (blen & 0x8000) !== 0;
        this.dictionary.push({ slice, flag });
      }
    }
  }

  unpack(data) {
    const out = [];
    let bitsleft = data.length * 8;
    const padded = Buffer.concat([data, Buffer.alloc(8)]);
    let pos = 0;
    let x = padded.readBigUInt64BE(0);
    let n = 32;

    const decodeInto = (buf, depth = 0) => {
      if (depth > 32) throw new Error("HUFF/CDIC recursion limit exceeded");
      return this.unpack(buf);
    };

    while (true) {
      if (n <= 0) {
        pos += 4;
        x = padded.readBigUInt64BE(pos);
        n += 32;
      }
      const code = (x >> BigInt(n)) & 0xffffffffn;
      const d1 = this.dict1[Number(code >> 24n)];
      let codelen = d1.codelen;
      let maxcode = BigInt(d1.maxcode);
      if (!d1.term) {
        while (code < this.mincode[codelen]) {
          codelen++;
        }
        maxcode = this.maxcode[codelen];
      }
      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;

      const r = Number((maxcode - code) >> BigInt(32 - codelen));
      const entry = this.dictionary[r];
      if (!entry) break;
      if (!entry.flag) {
        const resolved = decodeInto(entry.slice);
        this.dictionary[r] = { slice: resolved, flag: true };
        out.push(resolved);
      } else {
        out.push(entry.slice);
      }
    }
    return Buffer.concat(out);
  }
}

function decodeText(buf, encodingCode) {
  if (encodingCode === 1252) {
    return new TextDecoder("windows-1252").decode(buf);
  }
  return buf.toString("utf8");
}

function parseExth(rec, mobiLen) {
  const exthFlags = rec.length >= 132 ? rec.readUInt32BE(128) : 0;
  const exth = new Map();
  if (!(exthFlags & 0x40)) return exth;

  const exthStart = 16 + mobiLen;
  if (exthStart + 12 > rec.length) return exth;
  if (rec.subarray(exthStart, exthStart + 4).toString("latin1") !== "EXTH") {
    return exth;
  }

  const count = rec.readUInt32BE(exthStart + 8);
  let pos = exthStart + 12;
  for (let i = 0; i < count && pos + 8 <= rec.length; i++) {
    const type = rec.readUInt32BE(pos);
    const len = rec.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > rec.length) break;
    const data = rec.subarray(pos + 8, pos + len);
    if (!exth.has(type)) exth.set(type, []);
    exth.get(type).push(data);
    pos += len;
  }
  return exth;
}

function parseMobiHeader(rec) {
  const compression = rec.readUInt16BE(0);
  const textLength = rec.readUInt32BE(4);
  const recordCount = rec.readUInt16BE(8);
  const recordSize = rec.readUInt16BE(10);
  const encType = rec.readUInt16BE(12);

  if (rec.subarray(16, 20).toString("latin1") !== "MOBI") {
    throw new Error("Invalid AZW3/MOBI header (missing 'MOBI' magic)");
  }

  const mobiLen = rec.readUInt32BE(20);
  const mobiType = rec.readUInt32BE(24);
  const textEncoding = rec.readUInt32BE(28);
  const uniqueId = rec.readUInt32BE(32);
  const fileVersion = rec.readUInt32BE(36);
  const firstNonBook = rec.readUInt32BE(80);
  const fullNameOffset = rec.readUInt32BE(84);
  const fullNameLen = rec.readUInt32BE(88);
  const locale = rec.readUInt32BE(92);
  const firstImageIndex = rec.readUInt32BE(108);
  const huffOffset = rec.readUInt32BE(112);
  const huffCount = rec.readUInt32BE(116);

  const fdstIdx = mobiLen >= 192 ? rec.readUInt32BE(192) : 0xffffffff;
  const fdstCount = mobiLen >= 196 ? rec.readUInt32BE(196) : 0;
  const extraFlags = mobiLen >= 228 ? rec.readUInt16BE(242) : 0;
  const ncxIdx = mobiLen >= 232 ? rec.readUInt32BE(244) : 0xffffffff;
  const fragIdx = mobiLen >= 236 ? rec.readUInt32BE(248) : 0xffffffff;
  const skelIdx = mobiLen >= 240 ? rec.readUInt32BE(252) : 0xffffffff;

  let fullName = "";
  if (fullNameOffset > 0 && fullNameLen > 0 && fullNameOffset + fullNameLen <= rec.length) {
    fullName = decodeText(rec.subarray(fullNameOffset, fullNameOffset + fullNameLen), textEncoding);
  }

  const exth = parseExth(rec, mobiLen);

  return {
    compression,
    textLength,
    recordCount,
    recordSize,
    encType,
    mobiLen,
    mobiType,
    textEncoding,
    uniqueId,
    fileVersion,
    firstNonBook,
    fullName,
    locale,
    firstImageIndex,
    huffOffset,
    huffCount,
    fdstIdx,
    fdstCount,
    extraFlags,
    ncxIdx,
    fragIdx,
    skelIdx,
    exth,
  };
}

function parseINDX(getRec, startRecIdx, textEncoding) {
  const hdr = getRec(startRecIdx);
  if (hdr.length < 56 || hdr.subarray(0, 4).toString("latin1") !== "INDX") {
    return null;
  }

  const headerLen = hdr.readUInt32BE(4);
  const idxCount = hdr.readUInt32BE(24);
  const idxEncoding = hdr.readUInt32BE(28) || textEncoding;
  const cncxCount = hdr.readUInt32BE(52);

  // Parse TAGX section
  const tagx = [];
  let controlByteCount = 0;
  if (
    headerLen + 12 <= hdr.length &&
    hdr.subarray(headerLen, headerLen + 4).toString("latin1") === "TAGX"
  ) {
    const tagxLen = hdr.readUInt32BE(headerLen + 4);
    controlByteCount = hdr.readUInt32BE(headerLen + 8);
    for (let p = headerLen + 12; p + 4 <= headerLen + tagxLen; p += 4) {
      tagx.push({
        tag: hdr[p],
        numVals: hdr[p + 1],
        bitmask: hdr[p + 2],
        eof: hdr[p + 3],
      });
    }
  }

  // Parse CNCX string table records
  const cncx = new Map();
  let recOffset = 0;
  for (let c = 0; c < cncxCount; c++) {
    const crec = getRec(startRecIdx + 1 + idxCount + c);
    let pos = 0;
    while (pos < crec.length) {
      const entryOffset = recOffset + pos;
      const [strLen, consumed] = readVarIntForward(crec, pos);
      pos += consumed;
      if (pos + strLen > crec.length) break;
      const str = decodeText(crec.subarray(pos, pos + strLen), idxEncoding);
      cncx.set(entryOffset, str);
      pos += strLen;
    }
    recOffset += 0x10000;
  }

  // Parse INDX entry records
  const entries = [];
  for (let r = 0; r < idxCount; r++) {
    const rec = getRec(startRecIdx + 1 + r);
    if (rec.length < 28 || rec.subarray(0, 4).toString("latin1") !== "INDX") {
      continue;
    }
    const idxtOff = rec.readUInt32BE(20);
    const count = rec.readUInt32BE(24);

    for (let i = 0; i < count; i++) {
      const entryOff = rec.readUInt16BE(idxtOff + 4 + i * 2);
      const nameLen = rec[entryOff];
      const name = decodeText(
        rec.subarray(entryOff + 1, entryOff + 1 + nameLen),
        idxEncoding
      );
      let pos = entryOff + 1 + nameLen;
      const ctrlBytes = rec.subarray(pos, pos + controlByteCount);
      pos += controlByteCount;

      const tags = {};
      let ctrlIdx = 0;
      const pending = [];

      for (const t of tagx) {
        if (t.eof === 1) {
          ctrlIdx++;
          continue;
        }
        const masked = (ctrlBytes[ctrlIdx] ?? 0) & t.bitmask;
        if (masked === 0) continue;

        let shift = 0;
        let m = t.bitmask;
        while ((m & 1) === 0 && m > 0) {
          m >>= 1;
          shift++;
        }
        const val = masked >> shift;

        if (masked === t.bitmask) {
          const bitsSet = t.bitmask.toString(2).replace(/0/g, "").length;
          if (bitsSet > 1) {
            const [byteCount, cns] = readVarIntForward(rec, pos);
            pos += cns;
            pending.push({
              tag: t.tag,
              numVals: t.numVals,
              count: byteCount,
              isByteCount: true,
            });
          } else {
            pending.push({
              tag: t.tag,
              numVals: t.numVals,
              count: 1,
              isByteCount: false,
            });
          }
        } else {
          pending.push({
            tag: t.tag,
            numVals: t.numVals,
            count: val,
            isByteCount: false,
          });
        }
      }

      for (const p of pending) {
        const vals = [];
        if (p.isByteCount) {
          const endPos = Math.min(rec.length, pos + p.count);
          while (pos < endPos) {
            const [v, cns] = readVarIntForward(rec, pos);
            pos += cns;
            vals.push(v);
          }
        } else {
          for (let k = 0; k < p.count * p.numVals && pos < rec.length; k++) {
            const [v, cns] = readVarIntForward(rec, pos);
            pos += cns;
            vals.push(v);
          }
        }
        tags[p.tag] = vals;
      }

      entries.push({ name, tags });
    }
  }

  return { entries, cncx };
}

function detectImageType(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg", kind: "image" };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png", kind: "image" };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: "gif", mime: "image/gif", kind: "image" };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { ext: "bmp", mime: "image/bmp", kind: "image" };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp", kind: "image" };
  }
  // Check for inline SVG resource
  const head = buf.subarray(0, Math.min(256, buf.length)).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { ext: "svg", mime: "image/svg+xml", kind: "image" };
  }
  return null;
}

function decodeFontRecord(rec) {
  if (rec.length < 24 || rec.subarray(0, 4).toString("latin1") !== "FONT") {
    return null;
  }
  const flags = rec.readUInt32BE(8);
  const dataStart = rec.readUInt32BE(12);
  const xorLen = rec.readUInt32BE(16);
  const xorStart = rec.readUInt32BE(20);
  if (dataStart >= rec.length) return null;

  let fontData = Buffer.from(rec.subarray(dataStart));
  if ((flags & 0x02) && xorLen > 0 && xorStart + xorLen <= rec.length) {
    const key = rec.subarray(xorStart, xorStart + xorLen);
    const limit = Math.min(1040, fontData.length);
    for (let i = 0; i < limit; i++) {
      fontData[i] ^= key[i % xorLen];
    }
  }
  if (flags & 0x01) {
    try {
      fontData = inflateSync(fontData);
    } catch {
      return null;
    }
  }

  let ext = "ttf";
  let mime = "font/ttf";
  const magic = fontData.subarray(0, 4).toString("latin1");
  if (magic === "OTTO") {
    ext = "otf";
    mime = "font/otf";
  } else if (magic === "wOFF") {
    ext = "woff";
    mime = "font/woff";
  } else if (magic === "wOF2") {
    ext = "woff2";
    mime = "font/woff2";
  }
  return { ext, mime, kind: "font", data: fontData };
}

function detectFlowType(buf) {
  const sample = buf.subarray(0, Math.min(512, buf.length)).toString("utf8").trimStart();
  if (sample.startsWith("<svg") || (sample.startsWith("<?xml") && sample.includes("<svg"))) {
    return { ext: "svg", mime: "image/svg+xml", kind: "svg" };
  }
  if (sample.startsWith("<!DOCTYPE html") || sample.startsWith("<html") || (sample.startsWith("<?xml") && sample.includes("<html"))) {
    return { ext: "xhtml", mime: "application/xhtml+xml", kind: "xhtml" };
  }
  return { ext: "css", mime: "text/css", kind: "css" };
}

function getExthStrings(exth, type, encoding) {
  const list = exth.get(type);
  if (!list) return [];
  return list.map((b) => decodeText(b, encoding).trim()).filter(Boolean);
}

function getExthString(exth, type, encoding) {
  return getExthStrings(exth, type, encoding)[0] || "";
}

function getExthUint32(exth, type) {
  const list = exth.get(type);
  if (!list || list.length === 0 || list[0].length < 4) return null;
  return list[0].readUInt32BE(0);
}

function resolveLanguage(exth, locale, encoding) {
  const exthLang = getExthString(exth, 524, encoding);
  if (exthLang) return exthLang;
  if (LOCALE_MAP[locale]) return LOCALE_MAP[locale];
  const primary = locale & 0x3ff;
  if (LOCALE_MAP[primary]) return LOCALE_MAP[primary];
  return "zh-TW";
}

/**
 * Parse a DRM-free AZW3 (KF8) buffer into structured metadata, XHTML sections,
 * auxiliary flows (CSS/SVG), media/font resources, and hierarchical TOC.
 * @param {Buffer} buf
 */
export function parseAzw3(buf) {
  if (buf.length < 78) {
    throw new Error("File is too small to be a valid AZW3/PalmDB file.");
  }

  const pdbName = buf.subarray(0, 32).toString("latin1").replace(/\0+$/, "");
  const typeCreator = buf.subarray(60, 68).toString("latin1");
  if (typeCreator !== "BOOKMOBI") {
    throw new Error(`Unsupported file format "${typeCreator}" (expected "BOOKMOBI").`);
  }

  const numRecords = buf.readUInt16BE(76);
  if (numRecords === 0 || 78 + numRecords * 8 > buf.length) {
    throw new Error("Corrupted PalmDB record table.");
  }

  const recordOffsets = new Array(numRecords);
  for (let i = 0; i < numRecords; i++) {
    recordOffsets[i] = buf.readUInt32BE(78 + i * 8);
  }

  const getRec = (idx) => {
    if (idx < 0 || idx >= numRecords) return Buffer.alloc(0);
    const start = Math.min(recordOffsets[idx], buf.length);
    const end = Math.min(
      idx + 1 < numRecords ? recordOffsets[idx + 1] : buf.length,
      buf.length
    );
    return start < end ? buf.subarray(start, end) : Buffer.alloc(0);
  };

  // Parse primary MOBI header (Record 0)
  const primaryHeader = parseMobiHeader(getRec(0));
  if (primaryHeader.encType !== 0) {
    throw new Error(
      `This file is DRM-protected (encryption type ${primaryHeader.encType}) and cannot be converted.`
    );
  }

  // Handle joint MOBI7 + KF8 files via EXTH 121 (KF8 boundary record)
  let headerIdx = 0;
  let header = primaryHeader;
  if (primaryHeader.fileVersion < 8) {
    const boundary = getExthUint32(primaryHeader.exth, 121);
    if (boundary && boundary > 0 && boundary < numRecords && boundary !== 0xffffffff) {
      headerIdx = boundary;
      header = parseMobiHeader(getRec(headerIdx));
      if (header.encType !== 0) {
        throw new Error(
          `KF8 section is DRM-protected (encryption type ${header.encType}) and cannot be converted.`
        );
      }
    } else {
      throw new Error(
        `This file is legacy MOBI (version ${primaryHeader.fileVersion}) without a KF8/AZW3 section.`
      );
    }
  }

  // Decompress text records
  let huffDecoder = null;
  if (header.compression === 17480) {
    const huffIdx = header.huffOffset;
    const cdicRecs = [];
    for (let i = 1; i < header.huffCount; i++) {
      cdicRecs.push(getRec(huffIdx + i));
    }
    huffDecoder = new HuffCdicDecoder(getRec(huffIdx), cdicRecs);
  }

  const textChunks = [];
  for (let i = 1; i <= header.recordCount; i++) {
    const rawRec = stripTrailingData(getRec(headerIdx + i), header.extraFlags);
    if (header.compression === 1) {
      textChunks.push(rawRec);
    } else if (header.compression === 2) {
      textChunks.push(decompressPalmDOC(rawRec));
    } else if (header.compression === 17480) {
      textChunks.push(huffDecoder.unpack(rawRec));
    } else {
      throw new Error(`Unsupported compression type: ${header.compression}`);
    }
  }
  const rawText = Buffer.concat(textChunks);

  // Parse FDST flow table
  const flows = [];
  if (header.fdstIdx !== 0xffffffff && headerIdx + header.fdstIdx < numRecords) {
    const fdstRec = getRec(headerIdx + header.fdstIdx);
    if (fdstRec.length >= 12 && fdstRec.subarray(0, 4).toString("latin1") === "FDST") {
      const tableOffset = fdstRec.readUInt32BE(4);
      const numFlows = fdstRec.readUInt32BE(8);
      for (let i = 0; i < numFlows; i++) {
        const s = fdstRec.readUInt32BE(tableOffset + i * 8);
        const e = fdstRec.readUInt32BE(tableOffset + i * 8 + 4);
        flows.push(rawText.subarray(s, Math.min(e, rawText.length)));
      }
    }
  }
  if (flows.length === 0) {
    // Fallback when FDST record is missing or truncated at EOF:
    // header.textLength marks the exact end of Flow 0 (HTML), and trailing bytes are Flow 1 (e.g. CSS).
    if (header.textLength > 0 && header.textLength < rawText.length) {
      flows.push(rawText.subarray(0, header.textLength));
      flows.push(rawText.subarray(header.textLength));
    } else {
      flows.push(rawText);
    }
  }

  const flow0 = flows[0];

  // Extract auxiliary flows (Flow 1..N: CSS, SVG, etc.)
  const auxFlows = new Map();
  for (let i = 1; i < flows.length; i++) {
    const info = detectFlowType(flows[i]);
    auxFlows.set(i, {
      index: i,
      ...info,
      data: flows[i],
      text: decodeText(flows[i], header.textEncoding),
    });
  }

  // Parse SKEL & FRAG INDX tables to reconstruct XHTML sections accurately in UTF-8 bytes
  const skelData =
    header.skelIdx !== 0xffffffff
      ? parseINDX(getRec, headerIdx + header.skelIdx, header.textEncoding)
      : null;
  const fragData =
    header.fragIdx !== 0xffffffff
      ? parseINDX(getRec, headerIdx + header.fragIdx, header.textEncoding)
      : null;

  const sections = [];
  const fragToFile = new Map(); // fragIndex -> { fileIndex, insertPos, rawStart, rawEnd }
  const sectionRanges = []; // { fileIndex, start, end } in flow0

  if (skelData && skelData.entries.length > 0 && fragData) {
    // Group fragments by their skeleton fileNumber (tag 3), preserving order
    const fragsBySkel = new Map();
    fragData.entries.forEach((f, fid) => {
      const skelFileNum = f.tags[3]?.[0] ?? 0;
      if (!fragsBySkel.has(skelFileNum)) fragsBySkel.set(skelFileNum, []);
      fragsBySkel.get(skelFileNum).push({ fid, entry: f });
    });

    for (let sIdx = 0; sIdx < skelData.entries.length; sIdx++) {
      const skel = skelData.entries[sIdx];
      const skelStart = skel.tags[6]?.[0] ?? 0;
      const skelLen = skel.tags[6]?.[1] ?? 0;
      const skelEnd = skelStart + skelLen;
      const skelBytes = flow0.subarray(skelStart, skelEnd);

      const frags = fragsBySkel.get(sIdx) || [];
      let maxEnd = skelEnd;

      // Build reconstructed section buffer by inserting fragments at their exact byte offsets
      const parts = [];
      let cursor = 0;

      for (const { fid, entry } of frags) {
        const insertPos = parseInt(entry.name, 10);
        const relOffset = entry.tags[6]?.[0] ?? 0;
        const fragLen = entry.tags[6]?.[1] ?? 0;
        const fragAbsStart = skelEnd + relOffset;
        const fragAbsEnd = fragAbsStart + fragLen;
        if (fragAbsEnd > maxEnd) maxEnd = fragAbsEnd;

        const relInsert = Math.max(0, Math.min(skelLen, insertPos - skelStart));
        if (relInsert > cursor) {
          parts.push(skelBytes.subarray(cursor, relInsert));
          cursor = relInsert;
        }
        parts.push(flow0.subarray(fragAbsStart, fragAbsEnd));

        fragToFile.set(fid, {
          fileIndex: sIdx,
          insertPos,
          rawStart: fragAbsStart,
          rawEnd: fragAbsEnd,
        });
      }

      if (cursor < skelLen) {
        parts.push(skelBytes.subarray(cursor));
      }

      const fullBytes = Buffer.concat(parts);
      const html = decodeText(fullBytes, header.textEncoding);
      sections.push({
        index: sIdx,
        filename: `part${String(sIdx + 1).padStart(4, "0")}.xhtml`,
        html,
      });
      sectionRanges.push({ fileIndex: sIdx, start: skelStart, end: maxEnd });
    }
  } else {
    // Fallback: single XHTML section from Flow 0
    sections.push({
      index: 0,
      filename: "part0001.xhtml",
      html: decodeText(flow0, header.textEncoding),
    });
    sectionRanges.push({ fileIndex: 0, start: 0, end: flow0.length });
  }

  // Parse NCX table of contents
  const toc = [];
  if (header.ncxIdx !== 0xffffffff && headerIdx + header.ncxIdx < numRecords) {
    const ncxData = parseINDX(getRec, headerIdx + header.ncxIdx, header.textEncoding);
    if (ncxData && ncxData.entries.length > 0) {
      const flatNodes = ncxData.entries.map((entry, idx) => {
        const pos = entry.tags[1]?.[0] ?? 0;
        const labelOffset = entry.tags[3]?.[0];
        const label =
          (labelOffset !== undefined ? ncxData.cncx.get(labelOffset) : null) ||
          entry.name ||
          `Section ${idx + 1}`;
        const depth = entry.tags[4]?.[0] ?? 0;
        const posFid = entry.tags[6]; // [fid, offset]
        const parent = entry.tags[21]?.[0];

        // Resolve target section fileIndex
        let fileIndex = 0;
        if (posFid && fragToFile.has(posFid[0])) {
          fileIndex = fragToFile.get(posFid[0]).fileIndex;
        } else {
          // Binary/linear search in sectionRanges by Flow 0 byte offset
          for (let i = 0; i < sectionRanges.length; i++) {
            const r = sectionRanges[i];
            if (pos >= r.start && pos < r.end) {
              fileIndex = r.fileIndex;
              break;
            }
          }
        }

        return {
          index: idx,
          label: label.trim() || `Section ${idx + 1}`,
          depth,
          parent: parent !== undefined ? parent : -1,
          fileIndex,
          href: sections[fileIndex]?.filename || "part0001.xhtml",
          children: [],
        };
      });

      // Build hierarchical TOC tree
      const nodeByIndex = new Map(flatNodes.map((n) => [n.index, n]));
      for (const node of flatNodes) {
        if (node.parent >= 0 && nodeByIndex.has(node.parent)) {
          nodeByIndex.get(node.parent).children.push(node);
        } else {
          toc.push(node);
        }
      }
    }
  }

  // Extract media & font resources (1-based index matching kindle:embed:XXXX)
  const firstImgIdx =
    header.firstImageIndex !== 0xffffffff
      ? header.firstImageIndex
      : primaryHeader.firstImageIndex;

  const resources = new Map(); // 1-based resIndex -> { resIndex, kind, ext, mime, filename, data }
  if (firstImgIdx !== 0xffffffff && firstImgIdx < numRecords) {
    // Determine end boundary for resource scan (stop before joint KF8 header if primary, or scan to numRecords)
    for (let recIdx = firstImgIdx; recIdx < numRecords; recIdx++) {
      const rec = getRec(recIdx);
      if (rec.length < 4) continue;
      const magic4 = rec.subarray(0, 4).toString("latin1");
      if (NON_MEDIA_MAGICS.has(magic4)) continue;

      const resIndex = recIdx - firstImgIdx + 1; // 1-based for kindle:embed:0001

      if (magic4 === "FONT") {
        const font = decodeFontRecord(rec);
        if (font) {
          resources.set(resIndex, {
            resIndex,
            ...font,
            filename: `font_${String(resIndex).padStart(4, "0")}.${font.ext}`,
          });
        }
        continue;
      }

      const img = detectImageType(rec);
      if (img) {
        resources.set(resIndex, {
          resIndex,
          ...img,
          filename: `img_${String(resIndex).padStart(4, "0")}.${img.ext}`,
          data: rec,
        });
      }
    }
  }

  // Extract metadata (prefer KF8 EXTH, fallback to primary EXTH)
  const mergedExth = new Map([...primaryHeader.exth, ...header.exth]);
  const enc = header.textEncoding;
  const coverOffset = getExthUint32(mergedExth, 201);
  const thumbOffset = getExthUint32(mergedExth, 202);
  const coverResIndex =
    coverOffset !== null && coverOffset !== 0xffffffff && resources.has(coverOffset + 1)
      ? coverOffset + 1
      : null;
  const thumbResIndex =
    thumbOffset !== null && thumbOffset !== 0xffffffff && resources.has(thumbOffset + 1)
      ? thumbOffset + 1
      : null;

  const fixedLayout = getExthString(mergedExth, 122, enc).toLowerCase() === "true";
  const bookType = getExthString(mergedExth, 123, enc).toLowerCase();
  const orientationLock = getExthString(mergedExth, 124, enc).toLowerCase();
  const originalResolution = getExthString(mergedExth, 126, enc);
  const writingMode = getExthString(mergedExth, 525, enc).toLowerCase();

  let viewport = null;
  if (originalResolution) {
    const m = originalResolution.match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (m) {
      viewport = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
    }
  }

  const metadata = {
    title:
      getExthString(mergedExth, 503, enc) ||
      header.fullName ||
      primaryHeader.fullName ||
      pdbName ||
      "Untitled",
    authors: getExthStrings(mergedExth, 100, enc),
    publisher: getExthString(mergedExth, 101, enc),
    description: getExthString(mergedExth, 103, enc),
    isbn: getExthString(mergedExth, 104, enc),
    subjects: getExthStrings(mergedExth, 105, enc),
    date: getExthString(mergedExth, 106, enc),
    rights: getExthString(mergedExth, 109, enc),
    asin: getExthString(mergedExth, 113, enc),
    language: resolveLanguage(mergedExth, header.locale || primaryHeader.locale, enc),
    fixedLayout,
    bookType,
    orientationLock,
    originalResolution,
    viewport,
    writingMode,
    coverResIndex,
    thumbResIndex,
  };

  return {
    metadata,
    sections,
    auxFlows,
    resources,
    fragToFile,
    toc,
  };
}
