/**
 * 上传/下载日志：一份本地 JSON 同时充当"在飞锁"与"续传状态"。
 * 键 = contentId@hash(目的地)；内容只含 bundleId/seq/pid/时间戳（绝无任何密钥）。
 * 核心库不读时钟：now/startedAt/pid/pidAlive 由 CLI 注入。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type JournalKind = "upload" | "download";

export interface JournalEntry {
  readonly bundleId: string;
  readonly cloudDir: string;
  readonly contentId: string;
  readonly doneChunks: number[];
  readonly totalChunks: number;
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

export async function readJournal(path: string): Promise<JournalEntry | null> {
  try {
    const raw = await readFile(path, "utf8");
    const e = JSON.parse(raw) as JournalEntry;
    if (typeof e.bundleId !== "string" || !Array.isArray(e.doneChunks)) return null;
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
