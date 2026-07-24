/**
 * 预览生成（CLI 层）。
 * - 图片 → 缩略图（scale 宽 320，依赖 ffmpeg）
 * - 视频 → 抽一帧缩略图（依赖 ffmpeg）
 * - 音频 → 前 15 秒低码率片段（依赖 ffmpeg）
 * - 文本/代码 → 前 32KB（UTF-8 边界安全，零外部依赖）
 * - 压缩包（zip/tar/tar.gz）→ 条目名列表（纯解析，有界，见 genArchive）
 * - pdf → 暂返回 null（见 Task 4）
 * 生成的字节交给核心库用 DEK 加密为 preview.part。
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import type { PreviewKind } from "@bizhou/core";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".heic"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".m4v", ".wmv"]);
const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma"]);
const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonc",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".ini",
  ".toml",
  ".cfg",
  ".conf",
  ".env",
  ".properties",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".vue",
  ".svelte",
]);

export type PreviewStrategy = "image" | "video" | "audio" | "pdf" | "text" | "archive";

/** 依扩展名（小写）判定预览策略；未知类型返回 null（调用方据此跳过预览）。 */
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

/** 文本/代码预览：读取文件头 32KB，截到 UTF-8 字符边界。空文件返回空 buffer（仍是合法预览）。 */
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

function ffmpegBin(): string {
  return process.env.BIZHOU_FFMPEG_BIN ?? "ffmpeg";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
}

/** 图片/视频/音频预览：依赖 ffmpeg。返回 null 表示 ffmpeg 不可用或生成失败。 */
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
    // audio → 前 15 秒 64k mp3 片段
    const out = join(work, "clip.mp3");
    await runFfmpeg(["-i", src, "-t", "15", "-b:a", "64k", out]);
    return { kind, data: await readFile(out) };
  } catch {
    return null; // ffmpeg 缺失或失败：静默跳过预览（不阻断上传）
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

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
      const size = Math.max(0, Number.parseInt(sizeStr, 8) || 0);
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

/** tar.gz 扫描允许解压的总字节上限（防解压弹：巨大 size 声明 + 可压缩填充导致的耗时 DoS）。 */
const ARCHIVE_MAX_SCAN_BYTES = 64 * 1024 * 1024;

function listTarGz(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lister = new TarLister();
    const gunzip = createGunzip();
    const rs = createReadStream(path);
    let totalDecompressed = 0;
    const finish = (): void => {
      rs.destroy();
      gunzip.destroy();
      resolve(lister.result());
    };
    gunzip.on("data", (c: Buffer) => {
      totalDecompressed += c.length;
      try {
        lister.feed(c);
      } catch {
        finish();
        return;
      }
      if (lister.done || totalDecompressed > ARCHIVE_MAX_SCAN_BYTES) finish();
    });
    gunzip.on("end", () => resolve(lister.result()));
    gunzip.on("error", reject);
    rs.on("error", reject);
    rs.pipe(gunzip);
  });
}

/** 压缩包预览：列出条目名（zip 中央目录 / tar 头 / tar.gz 流式早停），有界、不缓冲文件数据。 */
export async function genArchive(path: string): Promise<{ kind: "text"; data: Buffer } | null> {
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

/**
 * 生成预览包。返回 null 表示：不支持的类型 / 生成失败（调用方据此跳过，不阻断上传）。
 */
export async function generatePreview(
  sourcePath: string,
): Promise<{ kind: PreviewKind; data: Buffer } | null> {
  const strat = detectStrategy(sourcePath);
  if (!strat) return null;
  // 绝对路径：防止以 - 开头的文件名被 ffmpeg 当作开关解析。
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
      return genArchive(src);
  }
}
