/**
 * 备份任务命令与 daemon 守护。
 * 单向依赖 commands.ts（pushOneFile/walkLocalFiles）；commands.ts 不得反向 import 本文件。
 */

import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  addBackup,
  type Backend,
  type BackupJob,
  BizhouError,
  defaultUploadCloudDir,
  deriveContentKey,
  joinCloudPath,
  normalizeCloudPath,
  readBackups,
  removeBackup,
  updateLastBackup,
} from "@bizhou/core";
import type { CommonOpts } from "./commands.ts";
import { pushOneFile, walkLocalFiles } from "./commands.ts";
import { info, ok, out, warn } from "./render.ts";
import type { Runtime } from "./runtime.ts";
import { makeBackend } from "./runtime.ts";

export interface SweepResult {
  uploaded: number;
  skipped: number;
  failed: number;
}
export type SweepLogger = (msg: string) => void;

/** 对一个备份任务做一次幂等 sweep：walk + 逐文件 pushOneFile（dedup 兜底），单文件错误隔离。 */
export async function sweepJob(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  job: BackupJob,
  log: SweepLogger,
): Promise<SweepResult> {
  const localDir = job.localDir;
  const st = await stat(localDir).catch(() => null);
  if (!st?.isDirectory()) {
    log(`跳过（源目录不存在）：${localDir}`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  // 镜像规则与 cmdPushRecursive 逐字一致
  const baseCloud = job.cloudDir
    ? normalizeCloudPath(job.cloudDir)
    : defaultUploadCloudDir(localDir + sep, rt.fileRoot);
  const rootCloud = joinCloudPath(baseCloud, basename(localDir));

  const files = await walkLocalFiles(localDir);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const abs of files) {
    const relDir = dirname(relative(localDir, abs));
    const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
    try {
      const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, {});
      if (r.status === "skipped-dup") skipped++;
      else if (r.status === "locked") {
        /* 正在传，跳过本轮 */
      } else {
        uploaded++;
        log(`已备份：${abs} → ${r.bundleId}`);
      }
    } catch (err) {
      failed++;
      log(`失败（跳过继续）：${abs} — ${(err as Error).message}`);
    }
  }
  return { uploaded, skipped, failed };
}

export async function cmdBackup(
  rt: Runtime,
  sub: string,
  arg: string | undefined,
  opts: CommonOpts & { to?: string },
): Promise<void> {
  switch (sub) {
    case "add": {
      if (!arg) {
        throw new BizhouError("INVALID_ARG", "用法：bz backup add <本地目录> [--to <云端目录>]");
      }
      const abs = resolve(arg);
      const st = await stat(abs).catch(() => null);
      if (!st?.isDirectory()) throw new BizhouError("INVALID_ARG", `不是目录：${abs}`);
      const cloudDir = opts.to ? normalizeCloudPath(opts.to) : undefined;
      const job = await addBackup(rt.paths.dir, {
        localDir: abs,
        ...(cloudDir ? { cloudDir } : {}),
        addedAt: new Date(rt.now()).toISOString(),
      });
      ok(`已注册备份任务 ${job.id}：${abs}${cloudDir ? ` → ${cloudDir}` : ""}`);
      return;
    }
    case "list": {
      const jobs = await readBackups(rt.paths.dir);
      if (jobs.length === 0) {
        info("（无备份任务）添加：bz backup add <目录> [--to <云端目录>]");
        return;
      }
      for (const j of jobs) {
        out(
          `${j.id}  ${j.localDir}${j.cloudDir ? ` → ${j.cloudDir}` : "（镜像）"}  上次：${j.lastBackupAt ?? "从未"}`,
        );
      }
      return;
    }
    case "rm": {
      if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz backup rm <id>");
      const removed = await removeBackup(rt.paths.dir, arg);
      if (removed) ok(`已删除备份任务 ${arg}（云端已备份数据不受影响）`);
      else warn(`未找到备份任务：${arg}`);
      return;
    }
    case "run": {
      const jobs = await readBackups(rt.paths.dir);
      const targets = arg ? jobs.filter((j) => j.id === arg) : jobs;
      if (targets.length === 0) {
        warn(arg ? `未找到备份任务：${arg}` : "（无备份任务）");
        return;
      }
      const mk = await rt.resolveMk(opts);
      const contentKey = deriveContentKey(mk);
      const backend = await makeBackend(rt, opts.local);
      for (const job of targets) {
        info(`备份 ${job.id}：${job.localDir}`);
        const r = await sweepJob(rt, backend, mk, contentKey, job, (m) => info(m));
        await updateLastBackup(rt.paths.dir, job.id, new Date(rt.now()).toISOString());
        ok(`任务 ${job.id} 完成：上传 ${r.uploaded}，跳过 ${r.skipped}，失败 ${r.failed}`);
      }
      return;
    }
    default:
      throw new BizhouError("INVALID_ARG", `未知子命令：backup ${sub}（用 add/list/rm）`);
  }
}
