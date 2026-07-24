/**
 * 备份任务模型与持久化：<keyRoot>/backups.json（{version, jobs}）。
 * 纯 IO，不碰网络/加密/时钟（addedAt/lastBackupAt 由 CLI 注入）。只存路径/时间/id，无密钥。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BACKUPS_FILENAME = "backups.json";
const BACKUPS_VERSION = 1;

export interface BackupJob {
  readonly id: string;
  readonly localDir: string;
  readonly cloudDir?: string;
  readonly addedAt: string;
  readonly lastBackupAt?: string;
}

interface BackupsFile {
  version: number;
  jobs: BackupJob[];
}

function backupsPath(keyRoot: string): string {
  return join(keyRoot, BACKUPS_FILENAME);
}

export async function readBackups(keyRoot: string): Promise<BackupJob[]> {
  let raw: string;
  try {
    raw = await readFile(backupsPath(keyRoot), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return []; // 尚未创建
    // 其它 IO 错误（EACCES/EIO 等）不吞：否则 add/remove/update 的 read-modify-write
    // 会误把"读失败"当"无任务"，写回时静默截断 backups.json（丢失任务注册）。
    throw err;
  }
  try {
    const f = JSON.parse(raw) as BackupsFile;
    if (!Array.isArray(f.jobs)) return [];
    return f.jobs.filter((j) => typeof j?.id === "string" && typeof j?.localDir === "string");
  } catch {
    return []; // 损坏 JSON：视为空（可被下次写入修复）
  }
}

async function writeBackups(keyRoot: string, jobs: BackupJob[]): Promise<void> {
  await mkdir(keyRoot, { recursive: true });
  const p = backupsPath(keyRoot);
  // 唯一 tmp 名（pid + 随机）：避免两个并发写者（如 daemon updateLastBackup 撞手动 add）
  // 争抢同一 tmp 文件而互相破坏。rename 本身原子，最坏是 last-writer-wins（可接受）。
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: BACKUPS_VERSION, jobs }, null, 2), "utf8");
  await rename(tmp, p); // 原子替换
}

export async function addBackup(
  keyRoot: string,
  input: { localDir: string; cloudDir?: string; addedAt: string },
): Promise<BackupJob> {
  const jobs = await readBackups(keyRoot);
  const existing = jobs.find(
    (j) => j.localDir === input.localDir && (j.cloudDir ?? "") === (input.cloudDir ?? ""),
  );
  if (existing) return existing; // 幂等
  const job: BackupJob = {
    id: randomBytes(4).toString("hex"),
    localDir: input.localDir,
    ...(input.cloudDir ? { cloudDir: input.cloudDir } : {}),
    addedAt: input.addedAt,
  };
  await writeBackups(keyRoot, [...jobs, job]);
  return job;
}

export async function removeBackup(keyRoot: string, id: string): Promise<boolean> {
  const jobs = await readBackups(keyRoot);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  await writeBackups(keyRoot, next);
  return true;
}

export async function updateLastBackup(
  keyRoot: string,
  id: string,
  whenISO: string,
): Promise<void> {
  const jobs = await readBackups(keyRoot);
  let changed = false;
  const next = jobs.map((j) => {
    if (j.id === id) {
      changed = true;
      return { ...j, lastBackupAt: whenISO };
    }
    return j;
  });
  if (changed) await writeBackups(keyRoot, next);
}
