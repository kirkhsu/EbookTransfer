import { randomUUID } from "node:crypto";
import { ZipBuilder } from "./zip.js";

const ALREADY_COMPRESSED_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "woff",
  "woff2",
]);

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseKindleBase32(str) {
  // Kindle uses standard base-32 digits 0-9, A-V (case-insensitive)
  const val = parseInt(str, 32);
  return Number.isNaN(val) ? -1 : val;
}

function computeTocMaxDepth(nodes, depth = 1) {
  let max = depth;
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      max = Math.max(max, computeTocMaxDepth(node.children, depth + 1));
    }
  }
  return max;
}

function buildNavListHtml(nodes, indent = "      ") {
  if (!nodes || nodes.length === 0) return "";
  const lines = [`${indent}<ol>`];
  for (const node of nodes) {
    const href = `Text/${encodeURI(node.href)}`;
    if (node.children && node.children.length > 0) {
      lines.push(`${indent}  <li>`);
      lines.push(`${indent}    <a href="${escapeXml(href)}">${escapeXml(node.label)}</a>`);
      lines.push(buildNavListHtml(node.children, `${indent}    `));
      lines.push(`${indent}  </li>`);
    } else {
      lines.push(
        `${indent}  <li><a href="${escapeXml(href)}">${escapeXml(node.label)}</a></li>`
      );
    }
  }
  lines.push(`${indent}</ol>`);
  return lines.join("\n");
}

function buildNcxNavPoints(nodes, counter, indent = "    ") {
  const lines = [];
  for (const node of nodes) {
    const playOrder = ++counter.value;
    const id = `navPoint-${playOrder}`;
    const src = `Text/${encodeURI(node.href)}`;
    lines.push(`${indent}<navPoint id="${id}" playOrder="${playOrder}">`);
    lines.push(`${indent}  <navLabel><text>${escapeXml(node.label)}</text></navLabel>`);
    lines.push(`${indent}  <content src="${escapeXml(src)}"/>`);
    if (node.children && node.children.length > 0) {
      lines.push(buildNcxNavPoints(node.children, counter, `${indent}  `));
    }
    lines.push(`${indent}</navPoint>`);
  }
  return lines.join("\n");
}

function normalizeXhtml(html, { viewport, stripAid }) {
  let out = html.trim();

  // Normalize XML declaration & DOCTYPE to EPUB 3 XHTML5
  out = out.replace(/^<\?xml[^>]*\?>\s*/i, "");
  out = out.replace(/^<!DOCTYPE[^>]*>\s*/i, "");

  if (!/^<html[\s>]/i.test(out)) {
    out = `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title></title></head><body>${out}</body></html>`;
  } else {
    // Ensure xmlns is present on <html>
    out = out.replace(/^<html\b([^>]*)>/i, (match, attrs) => {
      if (/xmlns\s*=/i.test(attrs)) return match;
      return `<html xmlns="http://www.w3.org/1999/xhtml"${attrs}>`;
    });
  }

  // Inject viewport meta tag for fixed-layout EPUB 3 pages if missing
  if (viewport && !/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(out)) {
    const vpTag = `<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}"/>`;
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${vpTag}\n</head>`);
    }
  }

  // Strip Kindle-proprietary aid="..." attributes if safe to do so
  if (stripAid) {
    out = out.replace(/\s+aid="[^"]*"/g, "");
  }

  // Ensure common void tags are self-closed for strict XHTML validity
  out = out.replace(
    /<(img|br|hr|meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?<!\/)>/gi,
    "<$1$2/>"
  );

  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${out}\n`;
}

/**
 * Build a complete EPUB 3 (with EPUB 2 NCX compatibility) Buffer from parsed AZW3 data.
 * @param {ReturnType<import('./azw3-parser.js').parseAzw3>} book
 * @returns {{ buffer: Buffer, stats: { pages: number, images: number, styles: number, fonts: number, tocEntries: number } }}
 */
export function buildEpub(book) {
  const { metadata, sections, auxFlows, resources, fragToFile, toc } = book;
  const bookUuid = `urn:uuid:${randomUUID()}`;
  const bookIdentifier = metadata.isbn || metadata.asin || bookUuid;
  const modifiedIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Track used resource indices and auxiliary flow indices
  const usedResIndices = new Set();
  const usedFlowIndices = new Set();

  if (metadata.coverResIndex && resources.has(metadata.coverResIndex)) {
    usedResIndices.add(metadata.coverResIndex);
  }

  // Determine auxiliary flow filenames & paths
  const flowPaths = new Map(); // flowIdx -> { oebpsPath, relFromText, relFromStyle, mime, kind, filename }
  for (const [flowIdx, flow] of auxFlows.entries()) {
    const pad = String(flowIdx).padStart(4, "0");
    if (flow.kind === "css") {
      const filename = `style_${pad}.css`;
      flowPaths.set(flowIdx, {
        oebpsPath: `Styles/${filename}`,
        relFromText: `../Styles/${filename}`,
        relFromStyle: filename,
        mime: "text/css",
        kind: "css",
        filename,
      });
    } else if (flow.kind === "svg") {
      const filename = `flow_${pad}.svg`;
      flowPaths.set(flowIdx, {
        oebpsPath: `Images/${filename}`,
        relFromText: `../Images/${filename}`,
        relFromStyle: `../Images/${filename}`,
        mime: "image/svg+xml",
        kind: "svg",
        filename,
      });
    } else {
      const filename = `flow_${pad}.${flow.ext}`;
      flowPaths.set(flowIdx, {
        oebpsPath: `Misc/${filename}`,
        relFromText: `../Misc/${filename}`,
        relFromStyle: `../Misc/${filename}`,
        mime: flow.mime,
        kind: flow.kind,
        filename,
      });
    }
  }

  // Determine resource filenames & paths
  const resPaths = new Map(); // 1-based resIndex -> { oebpsPath, relFromText, relFromStyle }
  for (const [resIdx, res] of resources.entries()) {
    const dir = res.kind === "font" ? "Fonts" : "Images";
    resPaths.set(resIdx, {
      oebpsPath: `${dir}/${res.filename}`,
      relFromText: `../${dir}/${res.filename}`,
      relFromStyle: `../${dir}/${res.filename}`,
    });
  }

  // Check if any CSS references [aid...] attribute
  let cssReferencesAid = false;
  for (const flow of auxFlows.values()) {
    if (flow.kind === "css" && /\[\s*aid\b/i.test(flow.text)) {
      cssReferencesAid = true;
      break;
    }
  }

  // Helper to rewrite kindle: URIs
  const rewriteKindleUris = (text, fromStyle = false) => {
    let result = text;

    // 1. kindle:embed:XXXX(?mime=...)
    result = result.replace(
      /kindle:embed:([0-9A-Za-z]+)(?:\?[^"'\s)]*)?/gi,
      (match, code) => {
        const resIdx = parseKindleBase32(code);
        const rp = resPaths.get(resIdx);
        if (!rp) return match;
        usedResIndices.add(resIdx);
        return fromStyle ? rp.relFromStyle : rp.relFromText;
      }
    );

    // 2. kindle:flow:XXXX(?mime=...)
    result = result.replace(
      /kindle:flow:([0-9A-Za-z]+)(?:\?[^"'\s)]*)?/gi,
      (match, code) => {
        const flowIdx = parseKindleBase32(code);
        const fp = flowPaths.get(flowIdx);
        if (!fp) return match;
        usedFlowIndices.add(flowIdx);
        return fromStyle ? fp.relFromStyle : fp.relFromText;
      }
    );

    // 3. kindle:pos:fid:XXXX:off:YYYYYYYYYY
    result = result.replace(
      /kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)/gi,
      (match, fidCode) => {
        const fid = parseKindleBase32(fidCode);
        const info = fragToFile.get(fid);
        if (!info) return "#";
        const sec = sections[info.fileIndex];
        return sec ? sec.filename : "#";
      }
    );

    return result;
  };

  // Process all XHTML sections
  const processedSections = sections.map((sec) => {
    const rewritten = rewriteKindleUris(sec.html, false);
    const normalized = normalizeXhtml(rewritten, {
      viewport: metadata.fixedLayout ? metadata.viewport : null,
      stripAid: !cssReferencesAid,
    });
    return {
      ...sec,
      oebpsPath: `Text/${sec.filename}`,
      xhtml: normalized,
    };
  });

  // Process auxiliary flows (CSS/SVG/etc.)
  const processedFlows = [];
  for (const [flowIdx, flow] of auxFlows.entries()) {
    // Include all CSS flows or any flow referenced from HTML
    if (flow.kind === "css" || usedFlowIndices.has(flowIdx)) {
      usedFlowIndices.add(flowIdx);
      const fp = flowPaths.get(flowIdx);
      let contentBuf = flow.data;
      if (flow.kind === "css" || flow.kind === "svg") {
        let rewritten = rewriteKindleUris(flow.text, flow.kind === "css");
        if (flow.kind === "css") {
          // Strip broken dummy @font-face blocks with placeholder url(XXXXXXXXXXXXXXXX)
          rewritten = rewritten.replace(
            /@font-face\s*\{[^}]*url\(\s*["']?X{4,}["']?\s*\)[^}]*\}\s*/gi,
            ""
          );
        }
        contentBuf = Buffer.from(rewritten, "utf8");
      }
      processedFlows.push({
        flowIdx,
        ...fp,
        data: contentBuf,
      });
    }
  }

  // Fallback TOC if NCX was empty
  const finalToc =
    toc.length > 0
      ? toc
      : processedSections.map((sec, idx) => ({
          index: idx,
          label: `Page ${idx + 1}`,
          href: sec.filename,
          children: [],
        }));

  // Build OEBPS/nav.xhtml (EPUB 3 Navigation Document)
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(metadata.language)}" lang="${escapeXml(metadata.language)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(metadata.title)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(metadata.title)}</h1>
${buildNavListHtml(finalToc, "    ")}
  </nav>
</body>
</html>
`;

  // Build OEBPS/toc.ncx (EPUB 2 backward-compatible NCX)
  const maxDepth = computeTocMaxDepth(finalToc);
  const playCounter = { value: 0 };
  const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookIdentifier)}"/>
    <meta name="dtb:depth" content="${maxDepth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${escapeXml(metadata.title)}</text>
  </docTitle>
  <navMap>
${buildNcxNavPoints(finalToc, playCounter, "    ")}
  </navMap>
</ncx>
`;

  // Determine cover image (prefer EXTH 201, fallback to first used image)
  let coverResIdx = metadata.coverResIndex;
  if (!coverResIdx || !resources.has(coverResIdx)) {
    for (const idx of usedResIndices) {
      if (resources.get(idx)?.kind === "image") {
        coverResIdx = idx;
        break;
      }
    }
  }
  if (coverResIdx && resources.has(coverResIdx)) {
    usedResIndices.add(coverResIdx);
  }

  // Collect used resources in index order
  const includedResources = [...usedResIndices]
    .sort((a, b) => a - b)
    .map((idx) => ({
      ...resources.get(idx),
      ...resPaths.get(idx),
      isCover: idx === coverResIdx,
    }))
    .filter((r) => r && r.data);

  // Build OEBPS/content.opf
  const metadataLines = [
    `    <dc:identifier id="BookId">${escapeXml(bookIdentifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(metadata.title)}</dc:title>`,
    `    <dc:language>${escapeXml(metadata.language)}</dc:language>`,
  ];
  for (const author of metadata.authors) {
    metadataLines.push(`    <dc:creator>${escapeXml(author)}</dc:creator>`);
  }
  if (metadata.publisher) {
    metadataLines.push(`    <dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`);
  }
  if (metadata.description) {
    metadataLines.push(
      `    <dc:description>${escapeXml(metadata.description)}</dc:description>`
    );
  }
  for (const subject of metadata.subjects) {
    metadataLines.push(`    <dc:subject>${escapeXml(subject)}</dc:subject>`);
  }
  if (metadata.date) {
    metadataLines.push(`    <dc:date>${escapeXml(metadata.date)}</dc:date>`);
  }
  if (metadata.rights) {
    metadataLines.push(`    <dc:rights>${escapeXml(metadata.rights)}</dc:rights>`);
  }
  metadataLines.push(`    <meta property="dcterms:modified">${modifiedIso}</meta>`);

  if (coverResIdx && resources.has(coverResIdx)) {
    metadataLines.push(`    <meta name="cover" content="cover-image"/>`);
  }

  if (metadata.fixedLayout) {
    metadataLines.push(`    <meta property="rendition:layout">pre-paginated</meta>`);
    const orientation =
      metadata.orientationLock === "portrait" || metadata.orientationLock === "landscape"
        ? metadata.orientationLock
        : "auto";
    metadataLines.push(
      `    <meta property="rendition:orientation">${orientation}</meta>`
    );
    metadataLines.push(`    <meta property="rendition:spread">auto</meta>`);
    metadataLines.push(`    <meta name="fixed-layout" content="true"/>`);
    if (metadata.originalResolution) {
      metadataLines.push(
        `    <meta name="original-resolution" content="${escapeXml(metadata.originalResolution)}"/>`
      );
    }
  }

  const manifestLines = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];

  const spineLines = [];
  for (const sec of processedSections) {
    const id = `sec_${String(sec.index + 1).padStart(4, "0")}`;
    manifestLines.push(
      `    <item id="${id}" href="${escapeXml(sec.oebpsPath)}" media-type="application/xhtml+xml"/>`
    );
    spineLines.push(`    <itemref idref="${id}"/>`);
  }

  for (const flow of processedFlows) {
    const id = `flow_${String(flow.flowIdx).padStart(4, "0")}`;
    manifestLines.push(
      `    <item id="${id}" href="${escapeXml(flow.oebpsPath)}" media-type="${escapeXml(flow.mime)}"/>`
    );
  }

  let imageCount = 0;
  let fontCount = 0;
  for (const res of includedResources) {
    if (res.kind === "font") fontCount++;
    else imageCount++;
    const id = res.isCover
      ? "cover-image"
      : `${res.kind}_${String(res.resIndex).padStart(4, "0")}`;
    const props = res.isCover ? ` properties="cover-image"` : "";
    manifestLines.push(
      `    <item id="${id}" href="${escapeXml(res.oebpsPath)}" media-type="${escapeXml(res.mime)}"${props}/>`
    );
  }

  const ppd =
    metadata.writingMode === "horizontal-rl" || metadata.writingMode === "vertical-rl"
      ? "rtl"
      : "ltr";

  const opfPrefix = metadata.fixedLayout
    ? ` prefix="rendition: http://www.idpf.org/vocab/rendition/#"`
    : "";

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId"${opfPrefix}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadataLines.join("\n")}
  </metadata>
  <manifest>
${manifestLines.join("\n")}
  </manifest>
  <spine toc="ncx" page-progression-direction="${ppd}">
${spineLines.join("\n")}
  </spine>
</package>
`;

  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  // Assemble EPUB ZIP archive
  const zip = new ZipBuilder();

  // 1. `mimetype` MUST be first and stored uncompressed
  zip.addFile("mimetype", "application/epub+zip", { compress: false });

  // 2. Container & package documents
  zip.addFile("META-INF/container.xml", containerXml, { compress: true });
  zip.addFile("OEBPS/content.opf", contentOpf, { compress: true });
  zip.addFile("OEBPS/nav.xhtml", navXhtml, { compress: true });
  zip.addFile("OEBPS/toc.ncx", tocNcx, { compress: true });

  // 3. XHTML sections
  for (const sec of processedSections) {
    zip.addFile(`OEBPS/${sec.oebpsPath}`, sec.xhtml, { compress: true });
  }

  // 4. Auxiliary flows (CSS, SVG, etc.)
  for (const flow of processedFlows) {
    zip.addFile(`OEBPS/${flow.oebpsPath}`, flow.data, { compress: true });
  }

  // 5. Images & fonts (skip DEFLATE on already-compressed formats for speed)
  for (const res of includedResources) {
    const shouldCompress = !ALREADY_COMPRESSED_EXTS.has(res.ext.toLowerCase());
    zip.addFile(`OEBPS/${res.oebpsPath}`, res.data, { compress: shouldCompress });
  }

  return {
    buffer: zip.toBuffer(),
    stats: {
      pages: processedSections.length,
      images: imageCount,
      styles: processedFlows.filter((f) => f.kind === "css").length,
      fonts: fontCount,
      tocEntries: playCounter.value,
    },
  };
}
