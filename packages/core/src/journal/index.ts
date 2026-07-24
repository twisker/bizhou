/**
 * 上传/下载日志：一份本地 JSON 同时充当"在飞锁"与"续传状态"。
 * 键 = contentId@hash(目的地)；内容只含 bundleId/seq/pid/时间戳（绝无任何密钥）。
 * 核心库不读时钟：now/startedAt/pid/pidAlive 由 CLI 注入。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Compression } from "../bundle/index.ts";

export type JournalKind = "upload" | "download";

export interface JournalEntry {
  readonly bundleId: string;
  readonly cloudDir: string;
  readonly contentId: string;
  readonly doneChunks: number[];
  readonly totalChunks: number;
  /**
   * 首次上传采用的分片大小（字节）与压缩方式。续传时必须原样沿用，忽略本次不同的
   * --chunk/--no-split/--compress。原因：确定性分片 IV 仅由 (DEK, bundleId, seq) 派生，
   * 而 seq→明文的映射还取决于 chunkSize 与 compression；若续传改用不同取值，则同一
   * (DEK, bundleId, seq) 会覆盖不同明文 → AES-GCM nonce 复用（机密性击穿 + tag 伪造）。
   * 固定这两项后 seq→明文稳定，重加密逐字节可复现，绝不复用 (key, IV) 于不同明文。
   * 上传专属：下载日志用不到（下载不重新加密，无 nonce 复用风险），可省略。
   */
  readonly chunkSize?: number;
  /** 上传专属：固定压缩方式（理由同 chunkSize）。下载省略。 */
  readonly compression?: Compression;
  /**
   * 该 bundle 的 DEK 被 MK 包裹后的 base64 blob（与 manifest.wrappedKey 同等保护）。
   * 续传时据此还原出与首次相同的 DEK，保证已上传分片与新 manifest 用同一 DEK。
   * 注意：这是 MK 包裹后的密文，绝非裸密钥；日志仅存于本地 keyRoot 下、绝不上云、绝不打印。
   * 上传专属：下载日志不需要重新封装 DEK，可省略。
   */
  readonly wrappedKey?: string;
  readonly startedAt: string; // ISO8601，CLI 注入
  readonly pid: number; // CLI 注入
}

const KIND_DIR: Record<JournalKind, string> = { upload: ".uploads", download: ".downloads" };

/** 日志文件路径：<keyRoot>/<.uploads|.downloads>/<contentId>@<destHash>.json */
export function journalPath(
  keyRoot: string,
  kind: JournalKind,
  contentId: string,
  destKey: string,
): string {
  const destHash = createHash("sha256").update(destKey).digest("hex").slice(0, 16);
  return join(keyRoot, KIND_DIR[kind], `${contentId}@${destHash}.json`);
}

/**
 * 校验解析出的对象是否具备 JournalEntry 的形状：必需字段（bundleId/cloudDir/contentId/
 * doneChunks/totalChunks/startedAt/pid）始终校验；上传专属字段（wrappedKey/chunkSize/
 * compression）若存在才校验类型——下载态日志省略它们仍视为合法。
 */
function isValidJournalEntry(e: unknown): e is JournalEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  const common =
    typeof o.bundleId === "string" &&
    typeof o.cloudDir === "string" &&
    typeof o.contentId === "string" &&
    Array.isArray(o.doneChunks) &&
    o.doneChunks.every((n) => typeof n === "number") &&
    typeof o.totalChunks === "number" &&
    typeof o.startedAt === "string" &&
    typeof o.pid === "number";
  if (!common) return false;
  if (o.wrappedKey !== undefined && typeof o.wrappedKey !== "string") return false;
  if (o.chunkSize !== undefined && typeof o.chunkSize !== "number") return false;
  if (o.compression !== undefined && o.compression !== "none" && o.compression !== "gzip")
    return false;
  return true;
}

export async function readJournal(path: string): Promise<JournalEntry | null> {
  try {
    const raw = await readFile(path, "utf8");
    const e: unknown = JSON.parse(raw);
    if (!isValidJournalEntry(e)) return null;
    return e;
  } catch {
    return null; // 缺失或损坏
  }
}

export async function writeJournal(path: string, entry: JournalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), "utf8");
  await rename(tmp, path); // 原子替换
}

// 非原子的读-改-写：仅在调用方对同一逻辑分片序列串行调用时才安全（并发调用会互相覆盖）。
export async function appendDoneChunk(path: string, seq: number): Promise<void> {
  const e = await readJournal(path);
  if (!e) return; // 日志已被清理则无操作
  if (!e.doneChunks.includes(seq)) {
    e.doneChunks.push(seq);
    e.doneChunks.sort((a, b) => a - b);
    await writeJournal(path, e);
  }
}

export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** 锁是否仍活：拥有进程存活，或虽已死但距 startedAt 未超 TTL（防误判刚启动的并发）。 */
export function isLockAlive(
  entry: JournalEntry,
  opts: { ttlMs: number; now: number; pidAlive: boolean },
): boolean {
  if (opts.pidAlive) return true;
  return opts.now - Date.parse(entry.startedAt) < opts.ttlMs;
}
