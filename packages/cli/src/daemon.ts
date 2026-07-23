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
import { watchRecursive } from "./watcher.ts";

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
  const localDir = resolve(job.localDir); // 与 cmdPushRecursive 对齐；防手改 backups.json 存入相对路径致云端落点偏移
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

/** 串行护栏：同一 runner 的 run() 绝不并发；运行中的多次 trigger 合并为一次补跑。 */
export class SerialJobRunner {
  private running = false;
  private dirty = false;
  private current: Promise<void> = Promise.resolve();
  constructor(private readonly run: () => Promise<void>) {}

  trigger(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    this.current = this.loop();
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.dirty = false;
        await this.run();
      } while (this.dirty);
    } finally {
      this.running = false;
    }
  }

  /** 等当前（及补跑）结束。 */
  async drain(): Promise<void> {
    await this.current;
  }
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

/**
 * 前台守护：启动即扫 + 实时监听（watchRecursive）+ 定时兜底（setInterval），
 * 每任务一个 SerialJobRunner 护栏（同任务绝不并发，运行中的多次触发合并为一次补跑）。
 * SIGINT/SIGTERM 优雅退出：停 watcher、清定时器、等在飞 sweep 全部 drain 完，再 resolve；
 * MK 仅驻内存至退出并 best-effort 抹除（mk.fill(0)）。
 */
export async function cmdDaemon(rt: Runtime, opts: CommonOpts): Promise<void> {
  const jobs = await readBackups(rt.paths.dir);
  if (jobs.length === 0) {
    info("无备份任务，先运行 `bz backup add <目录>`。");
    return;
  }
  const mk = await rt.resolveMk(opts); // 需已解锁或此处提示主密码
  const contentKey = deriveContentKey(mk);
  const backend = await makeBackend(rt, opts.local);

  // 每任务一个串行护栏
  const runners = new Map<string, SerialJobRunner>();
  for (const job of jobs) {
    runners.set(
      job.id,
      new SerialJobRunner(async () => {
        try {
          const r = await sweepJob(rt, backend, mk, contentKey, job, (m) => info(m));
          await updateLastBackup(rt.paths.dir, job.id, new Date(rt.now()).toISOString());
          info(`任务 ${job.id}：上传 ${r.uploaded}，跳过 ${r.skipped}，失败 ${r.failed}`);
        } catch (err) {
          warn(`任务 ${job.id} 本轮出错（下次触发重试）：${(err as Error).message}`);
        }
      }),
    );
  }

  info(`daemon 启动：${jobs.length} 个任务，启动即扫...`);
  for (const job of jobs) runners.get(job.id)?.trigger();
  await Promise.all([...runners.values()].map((r) => r.drain())); // 等启动即扫完

  const watchers = jobs.map((job) =>
    watchRecursive(job.localDir, () => runners.get(job.id)?.trigger(), {
      debounceMs: rt.daemonDebounceMs,
    }),
  );
  const timer = setInterval(() => {
    for (const job of jobs) runners.get(job.id)?.trigger();
  }, rt.daemonSweepIntervalMs);

  info(
    `监听中（防抖 ${rt.daemonDebounceMs}ms，定时兜底 ${Math.round(rt.daemonSweepIntervalMs / 60000)}min）。Ctrl-C 退出。`,
  );

  await new Promise<void>((resolve) => {
    let shutting = false;
    const shutdown = (sig: string): void => {
      if (shutting) return;
      shutting = true;
      info(`收到 ${sig}，停止 daemon（等在飞备份完成）...`);
      for (const w of watchers) w.stop();
      clearInterval(timer);
      void Promise.all([...runners.values()].map((r) => r.drain())).then(() => resolve());
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

  mk.fill(0); // best-effort 抹除内存 MK
  ok("daemon 已退出。");
}
