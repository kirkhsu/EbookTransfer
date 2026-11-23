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
import { parseAzw3 } from "./lib/azw3-parser.js";
import { buildEpub } from "./lib/epub-builder.js";

/**
 * Convert an AZW3 Buffer into an EPUB Buffer.
 * @param {Buffer} azw3Buffer
 */
export function convertAzw3Buffer(azw3Buffer) {
  const book = parseAzw3(azw3Buffer);
  const { buffer, stats } = buildEpub(book);
  return { buffer, metadata: book.metadata, stats };
}

/**
 * Convert a single AZW3 file on disk to an EPUB file.
 * @param {string} inputPath
 * @param {string} outputPath
 */
export function convertAzw3File(inputPath, outputPath) {
  const raw = readFileSync(inputPath);
  const result = convertAzw3Buffer(raw);
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

function collectAzw3Files(dir, recursive) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant")
  );
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        results.push(...collectAzw3Files(fullPath, recursive));
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".azw3") {
      results.push(fullPath);
    }
  }
  return results;
}

function printHelp() {
  console.log(`
AZW3 轉 EPUB 工具 (azw3-to-epub)
將無 DRM 保護的 AZW3 (KF8) 電子書轉換為標準 EPUB 3 格式（相容 EPUB 2）。

用法 (Usage):
  node azw3-to-epub.js [輸入檔案或資料夾] [選項]

範例 (Examples):
  node azw3-to-epub.js                           轉換目前資料夾內所有 .azw3 檔案
  node azw3-to-epub.js "book.azw3"               轉換單一檔案為 book.epub
  node azw3-to-epub.js "book.azw3" -o "out.epub" 指定輸出檔名
  node azw3-to-epub.js . -o ./epub_output        批次轉換並輸出至指定資料夾
  node azw3-to-epub.js . -o ./epub_output -f     強制覆寫已存在的 .epub 檔案

選項 (Options):
  -o, --output <path>   指定輸出檔案路徑（單檔模式）或輸出資料夾（批次模式）
  -f, --overwrite       覆寫已存在的輸出檔案（預設會略過已存在的檔案）
  -r, --recursive       遞迴搜尋子資料夾內的 .azw3 檔案
  -h, --help            顯示此說明訊息
`);
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    output: null,
    overwrite: false,
    recursive: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-f" || arg === "--overwrite") {
      opts.overwrite = true;
    } else if (arg === "-r" || arg === "--recursive") {
      opts.recursive = true;
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

  // Resolve input files -> { inputPath, outputPath }
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
      const base = basename(absInput, extname(absInput));
      let outPath;
      if (opts.output) {
        const absOut = resolve(opts.output);
        if (
          isSingleFileExplicit &&
          extname(absOut).toLowerCase() === ".epub"
        ) {
          outPath = absOut;
        } else {
          outPath = join(absOut, `${base}.epub`);
        }
      } else {
        outPath = join(dirname(absInput), `${base}.epub`);
      }
      tasks.push({ inputPath: absInput, outputPath: outPath });
    } else if (st.isDirectory()) {
      const files = collectAzw3Files(absInput, opts.recursive);
      for (const file of files) {
        const base = basename(file, extname(file));
        const outDir = opts.output ? resolve(opts.output) : dirname(file);
        tasks.push({
          inputPath: file,
          outputPath: join(outDir, `${base}.epub`),
        });
      }
    }
  }

  if (tasks.length === 0) {
    console.log("未找到任何 .azw3 檔案。");
    return;
  }

  console.log(`共找到 ${tasks.length} 個 AZW3 檔案，開始轉換...\n`);

  let converted = 0;
  let skipped = 0;
  let failed = 0;
  const totalStart = performance.now();

  for (let i = 0; i < tasks.length; i++) {
    const { inputPath, outputPath } = tasks[i];
    const label = `[${i + 1}/${tasks.length}]`;
    const fileName = basename(inputPath);

    if (existsSync(outputPath) && !opts.overwrite) {
      console.log(`${label} 略過（已存在）：${basename(outputPath)}`);
      skipped++;
      continue;
    }

    const start = performance.now();
    try {
      const res = convertAzw3File(inputPath, outputPath);
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      const layoutTag = res.metadata.fixedLayout ? "固定版面" : "流式版面";
      console.log(`${label} 完成：${fileName}`);
      console.log(
        `      -> ${outputPath} (${formatBytes(res.outputSize)}, ${res.stats.pages} 頁, ${res.stats.images} 張圖片, ${layoutTag}, ${elapsed}s)`
      );
      converted++;
    } catch (err) {
      console.error(`${label} 失敗：${fileName}`);
      console.error(`      原因：${err.message}`);
      failed++;
    }
  }

  const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(2);
  console.log(
    `\n轉換結束：成功 ${converted} 個、略過 ${skipped} 個、失敗 ${failed} 個（總耗時 ${totalElapsed}s）。`
  );
  if (failed > 0) process.exit(1);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
