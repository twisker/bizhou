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
  try {
    const f = JSON.parse(await readFile(backupsPath(keyRoot), "utf8")) as BackupsFile;
    if (!Array.isArray(f.jobs)) return [];
    return f.jobs.filter((j) => typeof j?.id === "string" && typeof j?.localDir === "string");
  } catch {
    return []; // 缺失或损坏
  }
}

async function writeBackups(keyRoot: string, jobs: BackupJob[]): Promise<void> {
  await mkdir(keyRoot, { recursive: true });
  const p = backupsPath(keyRoot);
  const tmp = `${p}.tmp`;
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
