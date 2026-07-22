/**
 * 预览生成（CLI 层，依赖 ffmpeg —— 属可选外部工具，不污染核心库纯逻辑）。
 * - 图片 → 缩略图（scale 宽 320）
 * - 视频 → 抽一帧缩略图
 * - 音频 → 前 15 秒低码率片段
 * 生成的字节交给核心库用 DEK 加密为 preview.part。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { PreviewKind } from "@bizhou/core";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".heic"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".m4v", ".wmv"]);
const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma"]);

export function detectKind(path: string): PreviewKind | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

function ffmpegBin(): string {
  return process.env.BIZHOU_FFMPEG_BIN ?? "ffmpeg";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`)),
    );
  });
}

/**
 * 生成预览包。返回 null 表示：非媒体类型 / ffmpeg 不可用 / 生成失败（调用方据此跳过）。
 */
export async function generatePreview(
  sourcePath: string,
): Promise<{ kind: PreviewKind; data: Buffer } | null> {
  const kind = detectKind(sourcePath);
  if (!kind) return null;
  const work = await mkdtemp(join(tmpdir(), "bizhou-prev-"));
  try {
    if (kind === "image" || kind === "video") {
      const out = join(work, "thumb.jpg");
      const vf = "scale=320:-1";
      const args =
        kind === "video"
          ? ["-i", sourcePath, "-ss", "00:00:01", "-vframes", "1", "-vf", vf, out]
          : ["-i", sourcePath, "-vf", vf, out];
      await runFfmpeg(args);
      return { kind, data: await readFile(out) };
    }
    // audio → 前 15 秒 64k mp3 片段
    const out = join(work, "clip.mp3");
    await runFfmpeg(["-i", sourcePath, "-t", "15", "-b:a", "64k", out]);
    return { kind, data: await readFile(out) };
  } catch {
    return null; // ffmpeg 缺失或失败：静默跳过预览（不阻断上传）
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
