# 更多预览类型 设计（Phase 3 · P1）

> 状态：已认可，待落实现计划。日期：2026-07-24。
> 归属：路线图 Phase 3「打磨与生态」候选「更多预览类型」。

## 背景与动机

现有 `bz push --preview` 仅支持媒体：图片/视频→320px jpg 缩略、音频→15s 片段（CLI 层 ffmpeg，可选、优雅降级；核心库把字节 DEK 加密为 `preview.part`）。扩展预览类型让更多资源在取回前可预览。

## 目标

- **P-G1 文本/代码预览**：文本类文件取前 32KB 作预览（新 `kind="text"`），**零外部依赖**；`bz preview` 直接打 stdout。
- **P-G2 PDF 首页缩略**：PDF 抽首页 → 320px 图（复用 `kind="image"`），经 `pdftoppm`（poppler，可选、优雅降级）。
- **P-G3 压缩包文件列表**：zip/tar/tar.gz 列出条目（每行一路径，上限 500 条）作文本预览（`kind="text"`），**零外部依赖**（内置 zlib + 纯解析）。
- **P-G4 全程优雅降级**：非目标类型 / 外部工具缺失 / 生成失败 → 返回 null，跳过预览、不阻断上传（与现有 ffmpeg 一致）。

**非目标（本轮）**：Office（docx/xlsx/pptx——需 libreoffice 重依赖，用户未选）；预览内容的富渲染（markdown→HTML 等）；对已上传 bundle 的预览补生成。

## 关键设计

### 核心：新增 `PreviewKind = "text"`

`packages/core/src/bundle/index.ts`：
- `PreviewKind` 联合类型加 `"text"` → `"video" | "audio" | "image" | "text"`。
- manifest 校验（`parseManifest` 里 `kind !== "video" && ...`）放开 `"text"`。
- 其余不变：`preview.part` 仍是 DEK 加密的字节（文本预览的 UTF-8 字节也照此加密），云端零可见。

### CLI：策略检测 + 分派

`preview.ts` 重构——`detectKind` 升级为策略检测：

```ts
type PreviewStrategy = "image" | "video" | "audio" | "pdf" | "text" | "archive";
export function detectStrategy(path: string): PreviewStrategy | null; // 按扩展名（小写）
```

- `image`/`video`/`audio`（现有扩展集）→ ffmpeg（现有 `genFfmpeg`），kind = 同名。
- `pdf`（`.pdf`）→ `genPdf`，kind = `"image"`。
- `text`（.txt/.md/.json/.csv/.log/.yaml/.yml/.xml/.ini/.toml + 源码 .ts/.js/.jsx/.tsx/.py/.go/.rs/.java/.c/.h/.cpp/.cs/.rb/.php/.sh/.sql 等）→ `genText`，kind = `"text"`。
- `archive`（.zip/.tar/.tar.gz/.tgz）→ `genArchive`，kind = `"text"`。

`generatePreview(sourcePath)` 保持签名 `Promise<{ kind: PreviewKind; data: Buffer } | null>`，内部按 `detectStrategy` 分派到各生成器；任一失败/工具缺失 → null。

### 生成器

**`genText(path)`（零依赖）**
- 读前 `TEXT_PREVIEW_BYTES = 32 * 1024` 字节；若末尾落在多字节 UTF-8 序列中间，回退到最后一个完整字符边界（避免半个字符）；空文件 → 空 buffer（仍是合法预览）。kind = `"text"`。
- 返回原始字节（`preview.part` 存字节；展示时按 UTF-8 解码）。

**`genPdf(path)`（poppler，可选）**
- `pdftoppm -png -f 1 -l 1 -scale-to 320 <src> <outprefix>`（`BIZHOU_PDFTOPPM_BIN` 覆盖，默认 `pdftoppm`）；读 `<outprefix>-1.png`（或 `-01.png`，实现时按实际输出名匹配）。工具缺失/失败 → null。kind = `"image"`。

**`genArchive(path)`（零依赖，内置 zlib + 纯解析）**
- `.zip` → 定位 EOCD（signature `0x06054b50`，从尾部扫描）读中央目录偏移与条目数；迭代中央目录记录（`0x02014b50`）读文件名长度 + 文件名。**不解压**，只列名。上限 `ARCHIVE_MAX_ENTRIES = 500`。
- `.tar` → 顺序读 512B 头块，取 name（offset 0，100B）与 size（offset 124，octal）；跳过数据块（size 向上取整到 512）；遇两个全零块或 EOF 停。上限同上。
- `.tar.gz`/`.tgz` → Node 内置 `zlib.createGunzip()` 流式解压，边解边喂 tar 解析器，**早停**（够 500 条或读满上限即停，避免整包解压）。
- 产出文本（每行一路径，末尾若截断加 `…（更多 N 条略）`）；损坏/不识别 → null。kind = `"text"`。

### 展示：`cmdPreview` 按 kind 分流

`packages/cli/src/commands.ts` 的 `cmdPreview`：
- `openPreview` → `{ kind, data }`。
- `kind === "text"` → **`out(data.toString("utf8"))` 打 stdout**（文本直接读；不写文件，忽略 `--out`，或 `--out` 给定时仍可另存——以简单为准：text 一律打 stdout）。
- 其余（`image`/`video`/`audio`）→ 落地文件（现有逻辑；ext：audio→mp3，image/video→jpg）。

## 文件结构

- 修改 `packages/core/src/bundle/index.ts` —— `PreviewKind` 加 `"text"` + 校验放开。
- 修改 `packages/cli/src/preview.ts` —— `detectStrategy` + `genText`/`genPdf`/`genArchive` + `generatePreview` 分派（保留现有 ffmpeg 路径）。
- 修改 `packages/cli/src/commands.ts` —— `cmdPreview` text→stdout 分流。

**核心库**：仅 `PreviewKind`/校验小改（预览生成逻辑全在 CLI，核心只加密存储）。

## 测试策略（TDD，先写失败测试）

**核心 PreviewKind（`bundle`）**
- 带 `kind:"text"` 的 manifest 往返（`serializeManifest`/`parseManifest`）合法；非法 kind 仍抛。

**`detectStrategy`（`preview`）**
- 各扩展名 → 正确策略（.txt→text、.pdf→pdf、.zip→archive、.mp4→video、未知→null）。

**`genText`（`preview`）**
- 前 32KB 截断；构造含多字节 UTF-8（中文）跨 32KB 边界的文件 → 截断点在完整字符边界、解码无乱码；空文件 → 空 buffer。

**`genArchive`（`preview`）**
- 测试内构造小 zip（用内置或手写最小 zip 字节）/tar/tar.gz → 断言列出全部文件名；超 500 条 → 截断 + 提示；损坏字节 → null。

**`cmdPreview` 分流（`commands`）**
- text kind → 打 stdout（捕获断言内容）；image kind → 落文件（临时目录断言存在）。

**往返（集成）**
- push 一个文本文件（`--preview`）→ bundle 带 text 预览 → `bz preview` 打出前 32KB 内容与原文件前 32KB 一致。

**（PDF：pdftoppm 缺失→null 的降级路径可测；真实 pdftoppm 抽帧 = 手动验证，登记人工。）**

## 里程碑拆分（约 4 个 TDD 任务）

- **P1-T1**：核心 `PreviewKind="text"` + manifest 校验放开 + 往返测试。
- **P1-T2**：`detectStrategy` 重构 + `genText`（前 32KB / UTF-8 边界）+ 测试。
- **P1-T3**：`genArchive`（zip 中央目录 / tar 头 / tar.gz 流式早停）+ 测试。
- **P1-T4**：`genPdf`（pdftoppm 可选，降级路径）+ `cmdPreview` text→stdout 分流 + 测试。

## 安全红线自检

- 预览字节仍 **DEK 加密**存 `preview.part`，云端零可见（含文本预览的明文片段——加密后不泄露）。
- 预览生成全在 **CLI 层**；核心库只加密存储、不新增生成逻辑、不 print。
- 外部工具（pdftoppm）路径可 env 覆盖；缺失/失败**静默降级**，绝不阻断上传。
- **零新增外部运行时依赖**（text/archive 纯 Node + 内置 zlib；pdftoppm 是运行时可选外部二进制，非 npm 依赖）。
- archive 解析**有界**（512B 头/中央目录记录逐条，上限 500 条；.gz 流式早停），防超大/构造包耗尽内存。
