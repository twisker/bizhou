# P1 · 更多预览类型 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 `bz push --preview` 支持文本/代码（前 32KB，零依赖）、PDF 首页缩略（pdftoppm 可选）、压缩包文件列表（zip/tar/tar.gz 纯解析），新增 `PreviewKind="text"`，`bz preview` 对 text 打 stdout。

**Architecture:** 核心库仅 `PreviewKind` 加 `"text"` + 校验放开（预览生成全在 CLI）。`preview.ts` 把 `detectKind` 升级为 `detectStrategy`，按策略分派到 `genFfmpeg`（现有）/`genPdf`/`genText`/`genArchive`；全部优雅降级（失败/工具缺失→null）。`cmdPreview` 对 text kind 打 stdout。

**Tech Stack:** TypeScript + Bun 测试；text/archive 用纯 Node + 内置 `node:zlib`（零新依赖）；pdftoppm 为运行时可选外部二进制（非 npm 依赖）。

**Spec:** `docs/superpowers/specs/2026-07-24-more-preview-types-design.md`。**依赖：** 现有 `preview.ts`（ffmpeg 路径）、`openPreview`/`packResource` 预览通路、`out` 渲染函数均已存在。

## Global Constraints

- 预览生成**全在 CLI 层**；核心库 `@bizhou/core` 只加密存储、不新增生成逻辑、不 print、不用 Bun 专有 API。
- 预览字节仍 **DEK 加密**存 `preview.part`，云端零可见（含文本预览的明文片段——加密后不泄露）。
- **零新增外部运行时（npm）依赖**：text/archive 纯 Node + 内置 `node:zlib`；pdftoppm 是可选外部二进制（env `BIZHOU_PDFTOPPM_BIN` 覆盖），缺失/失败**静默降级**、绝不阻断上传（与 ffmpeg 一致）。
- archive 解析**有界**：中央目录/tar 头逐条、上限 `ARCHIVE_MAX_ENTRIES=500`；.tar.gz 流式解压 + 早停，仅缓存 <512B + 当前 chunk，防超大/构造包耗尽内存。
- 版本号由 pre-commit `scripts/bump-version.sh` 自动处理，任务内**不手改** VERSION/package.json 版本。

---

### Task 1: 核心 `PreviewKind="text"` + manifest 校验放开

**Files:**
- Modify: `packages/core/src/bundle/index.ts`（`PreviewKind` 加 `"text"`；`parseManifest` 校验放开）
- Test: `packages/core/test/manifest-preview-text.test.ts`

**Interfaces:**
- Produces: `PreviewKind = "video" | "audio" | "image" | "text"`；manifest 接受 `preview.kind === "text"`。

- [ ] **Step 1: 写失败测试** `packages/core/test/manifest-preview-text.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { parseManifest, serializeManifest, type Manifest } from "../src/bundle/index.ts";

function baseManifest(previewKind: string): Manifest {
  return {
    version: 1,
    bundleId: "abcd",
    createdAt: "2026-07-24T00:00:00Z",
    cipher: "AES-256-GCM",
    compression: "none",
    chunkSize: 100,
    wrappedKey: "wk",
    chunks: [],
    preview: { file: "preview.part", kind: previewKind as never, iv: "iv", tag: "tag" },
    encMeta: "em",
  };
}

describe("manifest preview kind=text", () => {
  test("kind:text 往返合法", () => {
    const json = serializeManifest(baseManifest("text"));
    const m = parseManifest(json);
    expect(m.preview?.kind).toBe("text");
  });

  test("非法 kind 仍抛", () => {
    expect(() => parseManifest(serializeManifest(baseManifest("bogus")))).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/manifest-preview-text.test.ts`
Expected: FAIL（`kind:text` 被 `parseManifest` 拒绝）

- [ ] **Step 3: 放开校验**

`packages/core/src/bundle/index.ts`：
- `PreviewKind`：`export type PreviewKind = "video" | "audio" | "image" | "text";`
- `parseManifest` 里的校验：

```ts
    if (kind !== "video" && kind !== "audio" && kind !== "image" && kind !== "text") {
      throw new ManifestError(`不支持的 preview.kind：${kind}`);
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/core/test/manifest-preview-text.test.ts`
Expected: PASS（2 测试）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/bundle/index.ts packages/core/test/manifest-preview-text.test.ts`

```bash
git add packages/core/src/bundle/index.ts packages/core/test/manifest-preview-text.test.ts
git commit -m "feat(core): PreviewKind 增 text（manifest 校验放开）"
```

---

### Task 2: detectStrategy 重构 + genText

**Files:**
- Modify: `packages/cli/src/preview.ts`（`detectStrategy` + `genText` + `generatePreview` 分派；ffmpeg 逻辑抽为 `genFfmpeg`）
- Test: `packages/cli/test/preview-text.test.ts`

**Interfaces:**
- Produces:
  - `type PreviewStrategy = "image" | "video" | "audio" | "pdf" | "text" | "archive"`
  - `detectStrategy(path: string): PreviewStrategy | null`
  - `genText(path: string): Promise<{ kind: "text"; data: Buffer } | null>`
  - `generatePreview` 签名不变，内部按 strategy 分派。

- [ ] **Step 1: 写失败测试** `packages/cli/test/preview-text.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStrategy, genText } from "../src/preview.ts";

describe("detectStrategy", () => {
  test("扩展名 → 策略", () => {
    expect(detectStrategy("a.txt")).toBe("text");
    expect(detectStrategy("a.md")).toBe("text");
    expect(detectStrategy("a.ts")).toBe("text");
    expect(detectStrategy("a.pdf")).toBe("pdf");
    expect(detectStrategy("a.zip")).toBe("archive");
    expect(detectStrategy("a.tar.gz")).toBe("archive");
    expect(detectStrategy("a.mp4")).toBe("video");
    expect(detectStrategy("a.jpg")).toBe("image");
    expect(detectStrategy("a.unknownxyz")).toBeNull();
  });
});

describe("genText", () => {
  test("前 32KB 截断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt-"));
    try {
      const big = "x".repeat(50 * 1024);
      const p = join(dir, "big.txt");
      await writeFile(p, big, "utf8");
      const r = await genText(p);
      expect(r?.kind).toBe("text");
      expect(r?.data.length).toBe(32 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("UTF-8 多字节跨 32KB 边界 → 截到完整字符、解码无乱码", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt2-"));
    try {
      // 填充到 32KB 边界附近落在一个 3 字节中文中间
      const pad = "a".repeat(32 * 1024 - 1); // 边界前 1 字节
      const content = `${pad}中文尾`; // '中' 从第 32K-1 字节开始，跨界
      const p = join(dir, "u.txt");
      await writeFile(p, content, "utf8");
      const r = await genText(p);
      const decoded = r!.data.toString("utf8");
      expect(decoded).not.toContain("�"); // 无替换字符（无半个字）
      expect(r!.data.length).toBeLessThanOrEqual(32 * 1024); // 砍到边界
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("空文件 → 空 buffer（仍是合法预览）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt3-"));
    try {
      const p = join(dir, "empty.txt");
      await writeFile(p, "");
      const r = await genText(p);
      expect(r?.data.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/preview-text.test.ts`
Expected: FAIL（`detectStrategy`/`genText` 不存在）

- [ ] **Step 3: 重构 `preview.ts`**

新增/改动（保留现有 `IMAGE_EXT`/`VIDEO_EXT`/`AUDIO_EXT`、`ffmpegBin`、`runFfmpeg`）：

```ts
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".csv", ".tsv", ".log", ".yaml", ".yml",
  ".xml", ".ini", ".toml", ".cfg", ".conf", ".env", ".properties",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".scala", ".sh",
  ".bash", ".zsh", ".ps1", ".sql", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte",
]);

export type PreviewStrategy = "image" | "video" | "audio" | "pdf" | "text" | "archive";

export function detectStrategy(path: string): PreviewStrategy | null {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (ext === ".zip" || ext === ".tar" || ext === ".tgz" || lower.endsWith(".tar.gz")) {
    return "archive";
  }
  if (TEXT_EXT.has(ext)) return "text";
  return null;
}

const TEXT_PREVIEW_BYTES = 32 * 1024;

/** 把 buffer 截到最后一个完整 UTF-8 字符边界（丢掉末尾不完整的多字节序列）。 */
export function trimToUtf8Boundary(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80 && cont < 3) {
    i--;
    cont++;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  let need: number;
  if ((lead & 0x80) === 0) need = 1;
  else if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return buf; // 非法 lead：原样存
  const have = buf.length - i;
  return have >= need ? buf : buf.subarray(0, i);
}

export async function genText(path: string): Promise<{ kind: "text"; data: Buffer } | null> {
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.allocUnsafe(TEXT_PREVIEW_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TEXT_PREVIEW_BYTES, 0);
    return { kind: "text", data: trimToUtf8Boundary(buf.subarray(0, bytesRead)) };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
```

把现有 ffmpeg 生成逻辑抽成 `genFfmpeg(src, kind)`（保留原 image/video/audio 行为），并改写 `generatePreview`：

```ts
async function genFfmpeg(
  src: string,
  kind: "image" | "video" | "audio",
): Promise<{ kind: PreviewKind; data: Buffer } | null> {
  const work = await mkdtemp(join(tmpdir(), "bizhou-prev-"));
  try {
    if (kind === "image" || kind === "video") {
      const out = join(work, "thumb.jpg");
      const vf = "scale=320:-1";
      const args =
        kind === "video"
          ? ["-i", src, "-ss", "00:00:01", "-vframes", "1", "-vf", vf, out]
          : ["-i", src, "-vf", vf, out];
      await runFfmpeg(args);
      return { kind, data: await readFile(out) };
    }
    const out = join(work, "clip.mp3");
    await runFfmpeg(["-i", src, "-t", "15", "-b:a", "64k", out]);
    return { kind, data: await readFile(out) };
  } catch {
    return null;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function generatePreview(
  sourcePath: string,
): Promise<{ kind: PreviewKind; data: Buffer } | null> {
  const strat = detectStrategy(sourcePath);
  if (!strat) return null;
  const src = resolve(sourcePath);
  switch (strat) {
    case "image":
    case "video":
    case "audio":
      return genFfmpeg(src, strat);
    case "text":
      return genText(src);
    case "pdf":
      return null; // Task 4 接入 genPdf
    case "archive":
      return null; // Task 3 接入 genArchive
  }
}
```

> 删除旧的 `detectKind`（被 `detectStrategy` 取代）；若 `commands.ts`/别处 import 了 `detectKind`，改为 `detectStrategy` 或移除（本任务顺带修）。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/test/preview-text.test.ts`
Expected: PASS

- [ ] **Step 5: 回归 + 类型 + lint + 提交**

Run: `bun test && pnpm run typecheck && npx biome check --write packages/cli/src/preview.ts packages/cli/test/preview-text.test.ts`
Expected: 全绿（现有 preview 相关测试仍过）。

```bash
git add packages/cli/src/preview.ts packages/cli/test/preview-text.test.ts
git commit -m "feat(cli): detectStrategy + genText 文本预览（前32KB/UTF-8边界，零依赖）"
```

---

### Task 3: genArchive（zip/tar/tar.gz 纯解析，有界）

**Files:**
- Modify: `packages/cli/src/preview.ts`（`genArchive` + `TarLister` + `listZip`/`listTar`/`listTarGz`；`generatePreview` 接入）
- Test: `packages/cli/test/preview-archive.test.ts`

**Interfaces:**
- Produces: `genArchive(path: string): Promise<{ kind: "text"; data: Buffer } | null>`。

- [ ] **Step 1: 写失败测试** `packages/cli/test/preview-archive.test.ts`

> 测试内用内置 `node:zlib` 造 tar.gz，用手写最小 zip 字节造 zip。

```ts
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genArchive } from "../src/preview.ts";

/** 造一个含两个文件头的最小 tar（每文件仅头 + 0 数据块，末尾两个零块）。 */
function makeTar(names: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const name of names) {
    const b = Buffer.alloc(512);
    b.write(name, 0, "utf8"); // name @0
    b.write("0000000\0", 124, "ascii"); // size octal = 0
    // 简化：不算 checksum（listTar 不校验 checksum）
    blocks.push(b);
  }
  blocks.push(Buffer.alloc(512)); // 两个零块结束
  blocks.push(Buffer.alloc(512));
  return Buffer.concat(blocks);
}

/** 造最小 zip：一个空文件条目 + 中央目录 + EOCD（只需能被中央目录解析出名字）。 */
function makeZip(names: string[]): Buffer {
  // 本地文件头 + 中央目录记录 + EOCD；数据长度 0。
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, "utf8");
    const lf = Buffer.alloc(30 + nameBuf.length);
    lf.writeUInt32LE(0x04034b50, 0);
    lf.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lf, 30);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cd, 46);
    locals.push(lf);
    centrals.push(cd);
    offset += lf.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 10); // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe("genArchive", () => {
  test("zip → 列出文件名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc-"));
    try {
      const p = join(dir, "a.zip");
      await writeFile(p, makeZip(["a.txt", "sub/b.txt"]));
      const r = await genArchive(p);
      const text = r!.data.toString("utf8");
      expect(text).toContain("a.txt");
      expect(text).toContain("sub/b.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tar.gz → 列出文件名（内置 zlib）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc2-"));
    try {
      const p = join(dir, "a.tar.gz");
      await writeFile(p, gzipSync(makeTar(["x/one", "x/two"])));
      const r = await genArchive(p);
      const text = r!.data.toString("utf8");
      expect(text).toContain("x/one");
      expect(text).toContain("x/two");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("损坏包 → null（不抛）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc3-"));
    try {
      const p = join(dir, "bad.zip");
      await writeFile(p, Buffer.from("not a zip at all"));
      expect(await genArchive(p)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/preview-archive.test.ts`
Expected: FAIL（`genArchive` 不存在）

- [ ] **Step 3: 实现 archive 解析（`preview.ts`）**

```ts
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const ARCHIVE_MAX_ENTRIES = 500;

/** 流式 tar 头解析器：只取文件名、按 size 跳过数据块，够 N 条或遇零块即停。内存有界。 */
class TarLister {
  private names: string[] = [];
  private buf: Buffer = Buffer.alloc(0);
  private skip = 0; // 待丢弃的数据字节
  done = false;

  feed(chunk: Buffer): void {
    if (this.done) return;
    let data = chunk;
    if (this.skip > 0) {
      const drop = Math.min(this.skip, data.length);
      this.skip -= drop;
      data = data.subarray(drop);
      if (data.length === 0) return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= 512) {
      const block = this.buf.subarray(0, 512);
      if (block.every((b) => b === 0)) {
        this.done = true;
        return;
      }
      const raw = block.subarray(0, 100);
      const nul = raw.indexOf(0);
      const name = raw.toString("utf8", 0, nul === -1 ? 100 : nul);
      const sizeStr = block.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
      const size = Number.parseInt(sizeStr, 8) || 0;
      if (name) this.names.push(name);
      if (this.names.length >= ARCHIVE_MAX_ENTRIES) {
        this.done = true;
        return;
      }
      const dataLen = Math.ceil(size / 512) * 512;
      this.buf = this.buf.subarray(512);
      const inBuf = Math.min(dataLen, this.buf.length);
      this.buf = this.buf.subarray(inBuf);
      this.skip = dataLen - inBuf;
      if (this.skip > 0) return;
    }
  }

  result(): string[] {
    return this.names;
  }
}

function listTar(buf: Buffer): string[] {
  const l = new TarLister();
  l.feed(buf);
  return l.result();
}

function listZip(buf: Buffer): string[] {
  const EOCD = 0x06054b50;
  let p = buf.length - 22;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (; p >= min; p--) {
    if (p + 4 <= buf.length && buf.readUInt32LE(p) === EOCD) break;
  }
  if (p < min) throw new Error("no EOCD");
  const count = buf.readUInt16LE(p + 10);
  let off = buf.readUInt32LE(p + 16);
  const names: string[] = [];
  for (let i = 0; i < count && i < ARCHIVE_MAX_ENTRIES; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString("utf8", off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function listTarGz(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lister = new TarLister();
    const gunzip = createGunzip();
    const rs = createReadStream(path);
    const finish = (): void => {
      rs.destroy();
      gunzip.destroy();
      resolve(lister.result());
    };
    gunzip.on("data", (c: Buffer) => {
      lister.feed(c);
      if (lister.done) finish();
    });
    gunzip.on("end", () => resolve(lister.result()));
    gunzip.on("error", reject);
    rs.on("error", reject);
    rs.pipe(gunzip);
  });
}

export async function genArchive(
  path: string,
): Promise<{ kind: "text"; data: Buffer } | null> {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  try {
    let names: string[];
    if (ext === ".zip") names = listZip(await readFile(path));
    else if (ext === ".tgz" || lower.endsWith(".tar.gz")) names = await listTarGz(path);
    else if (ext === ".tar") names = listTar(await readFile(path));
    else return null;
    if (names.length === 0) return null;
    let text = names.join("\n");
    if (names.length >= ARCHIVE_MAX_ENTRIES) text += `\n…（仅列前 ${ARCHIVE_MAX_ENTRIES} 条）`;
    return { kind: "text", data: Buffer.from(text, "utf8") };
  } catch {
    return null;
  }
}
```

在 `generatePreview` 的 `case "archive"` 改为 `return genArchive(src);`

- [ ] **Step 4: 运行测试确认通过 + 回归**

Run: `bun test packages/cli/test/preview-archive.test.ts && bun test`
Expected: 全绿。

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/preview.ts packages/cli/test/preview-archive.test.ts`

```bash
git add packages/cli/src/preview.ts packages/cli/test/preview-archive.test.ts
git commit -m "feat(cli): genArchive 压缩包文件列表（zip中央目录/tar头/tar.gz流式早停，有界）"
```

---

### Task 4: genPdf（pdftoppm 可选）+ cmdPreview text→stdout

**Files:**
- Modify: `packages/cli/src/preview.ts`（`genPdf` + `generatePreview` 接入）
- Modify: `packages/cli/src/commands.ts`（`cmdPreview` text→stdout）
- Test: `packages/cli/test/preview-pdf-display.test.ts`

**Interfaces:**
- Produces: `genPdf(path: string): Promise<{ kind: "image"; data: Buffer } | null>`（pdftoppm 缺失/失败→null）。
- Consumes: `openPreview`（现有）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/preview-pdf-display.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genPdf } from "../src/preview.ts";

describe("genPdf 降级", () => {
  test("pdftoppm 不可用（指向不存在的 bin）→ null，不抛", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ppdf-"));
    const prev = process.env.BIZHOU_PDFTOPPM_BIN;
    try {
      process.env.BIZHOU_PDFTOPPM_BIN = "/nonexistent/pdftoppm-xyz";
      const p = join(dir, "a.pdf");
      await writeFile(p, Buffer.from("%PDF-1.4 fake")); // 内容无所谓，bin 不存在即降级
      expect(await genPdf(p)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.BIZHOU_PDFTOPPM_BIN;
      else process.env.BIZHOU_PDFTOPPM_BIN = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

> `cmdPreview` 的 text→stdout 分流用往返集成方式验证更稳（见 Step 5 回归）；本单测聚焦 genPdf 降级（不依赖真实 pdftoppm）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/preview-pdf-display.test.ts`
Expected: FAIL（`genPdf` 不存在）

- [ ] **Step 3: 实现 `genPdf`（`preview.ts`）**

```ts
import { readdir } from "node:fs/promises";

function pdftoppmBin(): string {
  return process.env.BIZHOU_PDFTOPPM_BIN ?? "pdftoppm";
}

function runPdftoppm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(pdftoppmBin(), args, { stdio: "ignore" });
    p.on("error", reject); // bin 不存在 → error → 上层 catch → null
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pdftoppm 退出码 ${code}`))));
  });
}

export async function genPdf(path: string): Promise<{ kind: "image"; data: Buffer } | null> {
  const src = resolve(path);
  const work = await mkdtemp(join(tmpdir(), "bizhou-pdf-"));
  try {
    const prefix = join(work, "pg");
    // 首页 → png，缩放到宽 320
    await runPdftoppm(["-png", "-f", "1", "-l", "1", "-scale-to", "320", src, prefix]);
    // pdftoppm 输出名可能是 pg-1.png / pg-01.png 等，取 work 下第一个 .png
    const files = (await readdir(work)).filter((f) => f.toLowerCase().endsWith(".png")).sort();
    if (files.length === 0) return null;
    return { kind: "image", data: await readFile(join(work, files[0]!)) };
  } catch {
    return null; // pdftoppm 缺失或失败：静默降级
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
```

`generatePreview` 的 `case "pdf"` 改为 `return genPdf(src);`

- [ ] **Step 4: `cmdPreview` text→stdout（`commands.ts`）**

把 `cmdPreview` 尾部改为按 kind 分流：

```ts
  const { kind, data } = await openPreview(mk, store);
  if (kind === "text") {
    out(data.toString("utf8")); // 文本预览直接打 stdout（--out 忽略）
    return;
  }
  const ext = kind === "audio" ? "mp3" : "jpg";
  const outPath = join(opts.out ?? ".", `${fullId.slice(0, 12)}-preview.${ext}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, data);
  ok(`预览（${kind}，${formatBytes(data.length)}）已保存：${outPath}`);
```

（`out` 从 render 引入，`commands.ts` 已在用。）

- [ ] **Step 5: 运行测试 + 往返集成 + 全量回归 + 构建**

Run: `bun test packages/cli/test/preview-pdf-display.test.ts && bun test && pnpm run build`
Expected: 全绿；构建通过。

> 若已有基于内存后端的 push/preview 往返测试夹具，加一例：push 一个文本文件 `--preview` → `bz preview`（或直接 `openPreview`）取回的 text 字节 == 原文件前 32KB（经 `trimToUtf8Boundary`）。无夹具则依赖 genText 单测 + 手动验证。

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/preview.ts packages/cli/src/commands.ts packages/cli/test/preview-pdf-display.test.ts`

```bash
git add packages/cli/src/preview.ts packages/cli/src/commands.ts packages/cli/test/preview-pdf-display.test.ts
git commit -m "feat(cli): genPdf 首页缩略（pdftoppm 可选降级）+ cmdPreview text→stdout 分流"
```

---

## 收尾（所有任务后）

- [ ] 全量 `bun test` + `pnpm run typecheck` + `npx biome check .` + `pnpm run build` 全绿。
- [ ] **手动/集成验证**（真机）：装 poppler 后 `bz push some.pdf --preview` → `bz preview <id> --out .` 看首页缩略图；`bz push some.log --preview` → `bz preview <id>` 看 stdout 文本；`bz push a.tar.gz --preview` → 看文件列表。记录到报告，人工登记（`人工TODO事项.md` 增 P1 pdftoppm 真机验证项）。
- [ ] 更新 `.claude/current-sprint.md`、`.claude/module-spec-registry.md`（preview 扩展）、`.claude/test-registry.md`（manifest-preview-text/preview-text/preview-archive/preview-pdf-display）、`.claude/sprint-plan.md`（Phase 3 · P1 完成）。
- [ ] 交由人工按 git flow 处理（本计划不 push）。

## 自审记录

- **Spec 覆盖**：PreviewKind=text 核心（T1）/ text 前32KB+UTF-8边界（T2）/ archive zip·tar·tar.gz 有界（T3）/ PDF pdftoppm 降级 + text→stdout 分流（T4）/ 全程优雅降级（各 generator catch→null）。
- **类型一致**：`PreviewStrategy`/`detectStrategy`/`genText`/`genArchive`/`genPdf` 跨任务一致；`generatePreview` 签名不变、内部分派；`PreviewKind` 核心加 text 后 CLI 各处 kind 联合自然扩展。
- **无占位符**：各步含完整测试与实现代码（含最小 zip/tar 构造）；真实 pdftoppm 抽帧明确登记手动验证。
- **安全**：预览字节仍 DEK 加密；生成全在 CLI；外部工具缺失静默降级不阻断上传；archive 解析有界（≤500 条、tar 流式内存有界、zip 中央目录逐条）。
- **零 npm 新依赖**：text/archive 用 `node:fs`/`node:zlib` 内置；pdftoppm 为可选外部二进制。
