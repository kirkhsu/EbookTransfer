#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixEpubBuffer, inspectEpub } from "./lib/epub-fixer.js";

/**
 * Fix an EPUB file on disk.
 * @param {string} inputPath
 * @param {string} outputPath
 */
export function fixEpubFile(inputPath, outputPath) {
  const raw = readFileSync(inputPath);
  const result = fixEpubBuffer(raw);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, result.buffer);
  return {
    inputSize: raw.length,
    outputSize: result.buffer.length,
    ...result,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function collectEpubFiles(dir, recursive) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant")
  );
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        results.push(...collectEpubFiles(fullPath, recursive));
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".epub") {
      results.push(fullPath);
    }
  }
  return results;
}

function printHelp() {
  console.log(`
EPUB 漫畫版面修復工具 (fix-epub)
專門修正從 Kindle (KF8/AZW3) 轉換為 EPUB 後，在 iPhone / iPad 的 Apple Books
中圖片向右偏移 50%、被切掉一半或無法置中的樣式定位問題。

用法 (Usage):
  node fix-epub.js [輸入檔案或資料夾] [選項]

範例 (Examples):
  node fix-epub.js "book.epub"                    修復單檔並輸出為 book_fixed.epub
  node fix-epub.js "book.epub" -i                 原地直接修復覆寫該檔案
  node fix-epub.js "book.epub" -o "out.epub"      指定輸出檔名
  node fix-epub.js .                              修復目前資料夾內所有 .epub 檔案
  node fix-epub.js . -i                           批次原地直接修復目前資料夾內所有檔案
  node fix-epub.js . -o ./repaired                批次修復並輸出至指定資料夾
  node fix-epub.js "book.epub" --check            僅檢查是否有此問題，不修改檔案

選項 (Options):
  -i, --in-place        直接在原檔案上進行修復覆寫
  -o, --output <path>   指定輸出檔案路徑（單檔）或輸出資料夾（批次）
  -f, --overwrite       強制覆寫已存在的輸出檔案（預設略過）
  -r, --recursive       遞迴搜尋子資料夾內的 .epub 檔案
  -c, --check           僅檢測檔案是否有排版裁切問題，不進行寫入
  -h, --help            顯示此說明訊息
`);
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    output: null,
    inPlace: false,
    overwrite: false,
    recursive: false,
    checkOnly: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-i" || arg === "--in-place") {
      opts.inPlace = true;
    } else if (arg === "-f" || arg === "--overwrite") {
      opts.overwrite = true;
    } else if (arg === "-r" || arg === "--recursive") {
      opts.recursive = true;
    } else if (arg === "-c" || arg === "--check") {
      opts.checkOnly = true;
    } else if (arg === "-o" || arg === "--output") {
      opts.output = argv[++i] ?? null;
    } else if (arg.startsWith("--output=")) {
      opts.output = arg.slice("--output=".length);
    } else if (!arg.startsWith("-")) {
      opts.inputs.push(arg);
    } else {
      throw new Error(`未知選項: ${arg}`);
    }
  }

  if (opts.inputs.length === 0) {
    opts.inputs.push(".");
  }

  return opts;
}

function runCli() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`錯誤：${err.message}`);
    printHelp();
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    return;
  }

  // Resolve input files
  const tasks = [];
  const isSingleFileExplicit =
    opts.inputs.length === 1 &&
    existsSync(resolve(opts.inputs[0])) &&
    statSync(resolve(opts.inputs[0])).isFile();

  for (const rawInput of opts.inputs) {
    const absInput = resolve(rawInput);
    if (!existsSync(absInput)) {
      console.error(`找不到路徑：${absInput}`);
      process.exit(1);
    }
    const st = statSync(absInput);
    if (st.isFile()) {
      const dir = dirname(absInput);
      const ext = extname(absInput);
      const base = basename(absInput, ext);
      let outPath;

      if (opts.inPlace) {
        outPath = absInput;
      } else if (opts.output) {
        const absOut = resolve(opts.output);
        if (isSingleFileExplicit && extname(absOut).toLowerCase() === ".epub") {
          outPath = absOut;
        } else {
          outPath = join(absOut, `${base}.epub`);
        }
      } else {
        outPath = join(dir, `${base}_fixed.epub`);
      }

      tasks.push({ inputPath: absInput, outputPath: outPath });
    } else if (st.isDirectory()) {
      const files = collectEpubFiles(absInput, opts.recursive);
      for (const file of files) {
        const dir = dirname(file);
        const base = basename(file, extname(file));
        let outPath;
        if (opts.inPlace) {
          outPath = file;
        } else if (opts.output) {
          outPath = join(resolve(opts.output), `${base}.epub`);
        } else {
          outPath = join(dir, `${base}_fixed.epub`);
        }
        tasks.push({ inputPath: file, outputPath: outPath });
      }
    }
  }

  if (tasks.length === 0) {
    console.log("未找到任何 .epub 檔案。");
    return;
  }

  console.log(`共找到 ${tasks.length} 個 EPUB 檔案，開始${opts.checkOnly ? "檢查" : "修復"}...\n`);

  let processed = 0;
  let fixedCount = 0;
  let skipped = 0;
  let failed = 0;
  const startTime = performance.now();

  for (let i = 0; i < tasks.length; i++) {
    const { inputPath, outputPath } = tasks[i];
    const label = `[${i + 1}/${tasks.length}]`;
    const fileName = basename(inputPath);

    if (opts.checkOnly) {
      try {
        const raw = readFileSync(inputPath);
        const info = inspectEpub(raw);
        if (info.hasIssue) {
          console.log(`⚠️  ${label} 發現問題：${fileName}`);
          console.log(`      -> 包含 Kindle 漫畫樣式且尚未套用 WebKit 置中修復`);
          fixedCount++;
        } else if (info.isAlreadyPatched) {
          console.log(`✅ ${label} 正常（已修復）：${fileName}`);
        } else {
          console.log(`ℹ️  ${label} 正常（非受影響版面）：${fileName}`);
        }
      } catch (err) {
        console.error(`❌ ${label} 檢查失敗：${fileName} (${err.message})`);
        failed++;
      }
      continue;
    }

    if (existsSync(outputPath) && !opts.overwrite && !opts.inPlace) {
      console.log(`⏭️  ${label} 略過（已存在）：${basename(outputPath)}`);
      skipped++;
      continue;
    }

    try {
      const t0 = performance.now();
      const raw = readFileSync(inputPath);
      const result = fixEpubBuffer(raw);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, result.buffer);

      const inSize = formatBytes(raw.length);
      const outSize = formatBytes(result.buffer.length);
      const isModified = result.stats.cssFilesPatched > 0 || result.stats.htmlFilesPatched > 0;

      if (isModified) {
        console.log(
          `✅ ${label} 修復完成：${fileName}\n` +
            `      -> ${outputPath}\n` +
            `      (${inSize} -> ${outSize}, 修復 ${result.stats.cssFilesPatched} 個 CSS、${result.stats.htmlFilesPatched} 頁 XHTML, 耗時 ${elapsed}s)`
        );
        fixedCount++;
      } else {
        console.log(
          `ℹ️  ${label} 無需修復（未發現切半問題）：${fileName}\n` +
            `      -> 已重新封裝至 ${outputPath} (${outSize}, 耗時 ${elapsed}s)`
        );
      }
      processed++;
    } catch (err) {
      console.error(`❌ ${label} 處理失敗：${fileName}`);
      console.error(`      原因：${err.message}`);
      failed++;
    }
  }

  const totalSec = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`\n========================================`);
  if (opts.checkOnly) {
    console.log(
      `檢查結束：共 ${tasks.length} 個，發現需修復 ${fixedCount} 個、正常 ${tasks.length - fixedCount - failed} 個、失敗 ${failed} 個（總耗時 ${totalSec}s）。`
    );
  } else {
    console.log(
      `修復結束：成功修復/處理 ${processed} 個、略過 ${skipped} 個、失敗 ${failed} 個（總耗時 ${totalSec}s）。`
    );
  }
}

// Run CLI when executed directly
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli();
}
