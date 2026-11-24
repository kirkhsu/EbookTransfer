import { parseZip, ZipBuilder } from "./zip.js";

const ALREADY_COMPRESSED_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "woff",
  "woff2",
]);

const FIX_STYLE_CSS = `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  div.fs div { top: 0 !important; left: 0 !important; }
  div.fs > div > img, div.fs > img, img.singlePage, img.twoPage {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: contain !important;
    margin: auto !important;
  }
`;

const FIX_STYLE_TAG = `<style type="text/css">${FIX_STYLE_CSS}</style>`;

/**
 * Patch CSS text to fix the Kindle Comic Creator / WebKit static positioning bug.
 * @param {string} cssText
 * @returns {{ css: string, patched: boolean }}
 */
export function patchCssContent(cssText) {
  let patched = false;
  let text = cssText;

  // 1. img.singlePage or .singlePage
  if (/img\.singlePage|\.singlePage/i.test(text)) {
    const next = text.replace(
      /((?:img)?\.singlePage\s*\{)([^}]*)(\})/gi,
      (match, p1, p2, p3) => {
        patched = true;
        return `${p1}\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n  margin: auto;\n  text-align: center;\n${p3}`;
      }
    );
    if (next !== text) {
      text = next;
    }
  }

  // 2. img.twoPage or .twoPage
  if (/img\.twoPage|\.twoPage/i.test(text)) {
    const next = text.replace(
      /((?:img)?\.twoPage\s*\{)([^}]*)(\})/gi,
      (match, p1, p2, p3) => {
        patched = true;
        return `${p1}\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n  margin: auto;\n  vertical-align: middle;\n${p3}`;
      }
    );
    if (next !== text) {
      text = next;
    }
  }

  // 3. div.fs div
  if (/div\.fs\s+div/i.test(text)) {
    const next = text.replace(
      /(div\.fs\s+div\s*\{)([^}]*)(\})/gi,
      (match, p1, p2, p3) => {
        let body = p2;
        let modified = false;
        if (!/\btop\s*:/i.test(body)) {
          body += "\n  top: 0;";
          modified = true;
        }
        if (!/\bleft\s*:/i.test(body)) {
          body += "\n  left: 0;";
          modified = true;
        }
        if (modified) patched = true;
        return `${p1}${body}\n${p3}`;
      }
    );
    if (next !== text) {
      text = next;
    }
  }

  return { css: text, patched };
}

/**
 * Patch XHTML/HTML text to inject compatibility CSS for fixed-layout comic rendering in WebKit / Apple Books.
 * @param {string} htmlText
 * @param {{ isFixedLayout?: boolean }} [options]
 * @returns {{ html: string, patched: boolean }}
 */
export function patchHtmlContent(htmlText, options = {}) {
  let text = htmlText;
  let patched = false;

  // Check if this page is a comic / fixed-layout page with div.fs or singlePage / twoPage
  const hasComicIndicators =
    /class=[\"'](?:singlePage|twoPage|fs)[\"']/i.test(text) ||
    /div\.fs/i.test(text) ||
    options.isFixedLayout;

  if (!hasComicIndicators) {
    return { html: text, patched: false };
  }

  // Patch any inline <style> blocks if present
  if (/<style\b/i.test(text)) {
    text = text.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (match, openTag, cssBody, closeTag) => {
        const { css, patched: p } = patchCssContent(cssBody);
        if (p) patched = true;
        return `${openTag}${css}${closeTag}`;
      }
    );
  }

  // Inject fix style tag if not already injected
  if (!text.includes("object-fit: contain !important")) {
    if (/<\/head>/i.test(text)) {
      text = text.replace(/<\/head>/i, `${FIX_STYLE_TAG}\n</head>`);
      patched = true;
    } else if (/<body/i.test(text)) {
      text = text.replace(/<body/i, `${FIX_STYLE_TAG}\n<body`);
      patched = true;
    }
  }

  return { html: text, patched };
}

/**
 * Inspect an EPUB buffer to check whether it contains the fixed-layout Apple Books clipping bug.
 * @param {Buffer} epubBuffer
 */
export function inspectEpub(epubBuffer) {
  const entries = parseZip(epubBuffer);
  let hasKindleComicCss = false;
  let hasSinglePage = false;
  let hasTwoPage = false;
  let hasFsDiv = false;
  let isFixedLayout = false;
  let isAlreadyPatched = false;

  for (const [name, entry] of entries) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".opf")) {
      const opf = entry.data.toString("utf8");
      if (/pre-paginated|fixed-layout/i.test(opf)) {
        isFixedLayout = true;
      }
    } else if (lower.endsWith(".css")) {
      const css = entry.data.toString("utf8");
      if (/singlePage/i.test(css)) hasSinglePage = true;
      if (/twoPage/i.test(css)) hasTwoPage = true;
      if (/div\.fs/i.test(css)) hasFsDiv = true;
      if (/object-fit:\s*contain/i.test(css)) isAlreadyPatched = true;
    } else if (lower.endsWith(".xhtml") || lower.endsWith(".html")) {
      const html = entry.data.toString("utf8");
      if (/singlePage|twoPage/i.test(html)) hasSinglePage = true;
      if (/div class=[\"']fs[\"']/i.test(html)) hasFsDiv = true;
      if (html.includes("object-fit: contain !important")) isAlreadyPatched = true;
    }
  }

  hasKindleComicCss = hasSinglePage || hasTwoPage || hasFsDiv;
  const hasIssue = (hasKindleComicCss || isFixedLayout) && !isAlreadyPatched;

  return {
    hasIssue,
    isFixedLayout,
    hasKindleComicCss,
    isAlreadyPatched,
    totalFiles: entries.size,
  };
}

/**
 * Fix an EPUB buffer by patching CSS and XHTML files to display correctly in Apple Books.
 * @param {Buffer} epubBuffer
 * @returns {{ buffer: Buffer, stats: { totalFiles: number, cssFilesPatched: number, htmlFilesPatched: number, detectedIssues: boolean, isAlreadyPatched: boolean } }}
 */
export function fixEpubBuffer(epubBuffer) {
  const entries = parseZip(epubBuffer);

  // Validate mimetype
  const mimeEntry = entries.get("mimetype");
  if (!mimeEntry) {
    throw new Error("無效的 EPUB 檔案：缺少 mimetype 檔案");
  }

  // Detect fixed-layout from OPF
  let isFixedLayout = false;
  for (const [name, entry] of entries) {
    if (name.toLowerCase().endsWith(".opf")) {
      const opf = entry.data.toString("utf8");
      if (/pre-paginated|fixed-layout/i.test(opf)) {
        isFixedLayout = true;
        break;
      }
    }
  }

  let cssFilesPatched = 0;
  let htmlFilesPatched = 0;
  let detectedIssues = false;
  let isAlreadyPatched = false;

  // Process all files
  const updatedEntries = new Map();

  for (const [name, entry] of entries) {
    const lower = name.toLowerCase();
    const ext = lower.split(".").pop();

    if (ext === "css") {
      const originalText = entry.data.toString("utf8");
      if (/object-fit:\s*contain/i.test(originalText)) {
        isAlreadyPatched = true;
      }
      if (/singlePage|twoPage|div\.fs/i.test(originalText)) {
        detectedIssues = true;
      }
      const { css, patched } = patchCssContent(originalText);
      if (patched) {
        cssFilesPatched++;
        updatedEntries.set(name, Buffer.from(css, "utf8"));
      } else {
        updatedEntries.set(name, entry.data);
      }
    } else if (ext === "xhtml" || ext === "html" || ext === "htm") {
      const originalText = entry.data.toString("utf8");
      if (originalText.includes("object-fit: contain !important")) {
        isAlreadyPatched = true;
      }
      if (/singlePage|twoPage|class=[\"']fs[\"']/i.test(originalText)) {
        detectedIssues = true;
      }
      const { html, patched } = patchHtmlContent(originalText, { isFixedLayout });
      if (patched) {
        htmlFilesPatched++;
        updatedEntries.set(name, Buffer.from(html, "utf8"));
      } else {
        updatedEntries.set(name, entry.data);
      }
    } else {
      updatedEntries.set(name, entry.data);
    }
  }

  // Re-assemble EPUB ZIP
  const zip = new ZipBuilder();

  // 1. mimetype MUST be first and STORE (uncompressed)
  zip.addFile("mimetype", mimeEntry.data, { compress: false });

  // 2. Add remaining entries in standard order
  const names = Array.from(updatedEntries.keys()).filter((n) => n !== "mimetype");

  // Sort logically: META-INF first, then OPF/NCX/Nav, then Text, Styles, Images, others
  names.sort((a, b) => {
    const priority = (path) => {
      if (path.startsWith("META-INF/")) return 1;
      if (path.endsWith(".opf")) return 2;
      if (path.endsWith("nav.xhtml") || path.endsWith(".ncx")) return 3;
      if (path.includes("/Text/") || path.includes("/text/")) return 4;
      if (path.includes("/Styles/") || path.includes("/styles/")) return 5;
      if (path.includes("/Images/") || path.includes("/images/")) return 6;
      return 7;
    };
    const pA = priority(a);
    const pB = priority(b);
    if (pA !== pB) return pA - pB;
    return a.localeCompare(b, "zh-Hant");
  });

  for (const name of names) {
    const data = updatedEntries.get(name);
    const ext = name.toLowerCase().split(".").pop();
    const shouldCompress = !ALREADY_COMPRESSED_EXTS.has(ext);
    zip.addFile(name, data, { compress: shouldCompress });
  }

  return {
    buffer: zip.toBuffer(),
    stats: {
      totalFiles: entries.size,
      cssFilesPatched,
      htmlFilesPatched,
      detectedIssues: detectedIssues || cssFilesPatched > 0 || htmlFilesPatched > 0,
      isAlreadyPatched,
    },
  };
}
