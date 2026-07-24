/**
 * 预览生成（CLI 层）。
 * - 图片 → 缩略图（scale 宽 320，依赖 ffmpeg）
 * - 视频 → 抽一帧缩略图（依赖 ffmpeg）
 * - 音频 → 前 15 秒低码率片段（依赖 ffmpeg）
 * - 文本/代码 → 前 32KB（UTF-8 边界安全，零外部依赖）
 * - pdf/archive → 暂返回 null（分别见 Task 4 / Task 3）
 * 生成的字节交给核心库用 DEK 加密为 preview.part。
 */

import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
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
      return null; // Task 3 接入 genArchive
  }
}
