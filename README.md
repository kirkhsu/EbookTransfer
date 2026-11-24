# AZW3 轉 EPUB 轉換工具 (`azw3-to-epub`)

純 Node.js 實作、**零外部相依套件**（不需安裝 Calibre 或 Python），可將無 DRM 保護的 `.azw3` (KF8) 電子書轉換為標準 EPUB 3 格式（同時內建 `toc.ncx` 相容 EPUB 2 閱讀器）。

## 功能特色

- 完整解析 PalmDB / MOBI / KF8（含聯合 MOBI7+KF8 檔案）
- 支援未壓縮、PalmDOC 與 HUFF/CDIC 壓縮格式
- 以 UTF-8 位元組精準重組 `SKEL` + `FRAG` 章節頁面，支援中文/日文/韓文不偏移
- 自動轉換 `kindle:embed:`、`kindle:flow:` 與 `kindle:pos:fid:` 內部資源與連結
- 支援圖片（JPEG/PNG/GIF/BMP/WebP/SVG）、內嵌字型（`FONT` 解混淆）與 CSS 樣式表
- 自動保留書目資訊（書名、作者、出版社、封面圖、多層目錄）
- 支援**固定版面漫畫/繪本**（自動寫入 `rendition:layout=pre-paginated` 與 `viewport`）及流式文字書
- 針對尾部截斷的 AZW3 檔案具備 `FDST` 自動救援機制

## 檔案結構

- `azw3-to-epub.js`：AZW3 轉 EPUB 主程式與 CLI 介面
- `fix-epub.js`：專門修復固定版面漫畫在 Apple Books 中切半、偏移的修復工具
- `lib/azw3-parser.js`：AZW3 / KF8 二進位格式解析器
- `lib/epub-builder.js`：EPUB 3 / EPUB 2 封裝器
- `lib/epub-fixer.js`：EPUB 樣式修復模組（修正 `singlePage`/`twoPage` 定位）
- `lib/zip.js`：符合 EPUB 規範的 ZIP 產生器與解析器（零相依）

## 使用方式

需求：Node.js 18 以上（不需 `npm install`）。

```powershell
# 1. 轉換目前資料夾內的所有 .azw3 檔案
node azw3-to-epub.js

# 2. 批次轉換並輸出到指定資料夾
node azw3-to-epub.js . -o ./epub_output

# 3. 轉換單一檔案
node azw3-to-epub.js "書名.azw3"

# 4. 轉換單一檔案並指定輸出檔名
node azw3-to-epub.js "書名.azw3" -o "輸出書名.epub"

# 5. 強制覆寫已存在的 .epub 檔案（預設會略過）
node azw3-to-epub.js . -o ./epub_output -f

# 6. 遞迴搜尋子資料夾內的 .azw3 檔案
node azw3-to-epub.js ./books -o ./epub_output -r
```

## 作為 Node.js 模組使用

```js
import { convertAzw3File } from "./azw3-to-epub.js";

const result = convertAzw3File("input.azw3", "output.epub");
console.log(result.metadata.title, result.stats);
```

## 修復現有 EPUB 漫畫切半問題 (`fix-epub`)

專門修正從 Kindle (KF8/AZW3) 轉換為 EPUB 後，在 iPhone / iPad 的 Apple Books（WebKit 核心）中圖片向右偏移 50%、被切掉一半或無法置中的樣式定位問題：

```powershell
# 1. 檢測檔案是否存在此問題（不寫入任何變更）
node fix-epub.js "漫畫.epub" --check

# 2. 原地直接修復單一檔案
node fix-epub.js "漫畫.epub" -i

# 3. 修復單一檔案並另存新檔（預設命名為 漫畫_fixed.epub）
node fix-epub.js "漫畫.epub"

# 4. 指定修復後輸出檔名
node fix-epub.js "漫畫.epub" -o "修正後.epub"

# 5. 批次修復資料夾內所有 EPUB 並原地覆寫
node fix-epub.js ./epubs -i -r
```

## 限制

- 僅支援**無 DRM 加密保護**的 AZW3 (KF8) 檔案。
