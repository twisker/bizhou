/**
 * 备份任务命令与 daemon 守护。
 * 单向依赖 commands.ts（pushOneFile/walkLocalFiles）；commands.ts 不得反向 import 本文件。
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  addBackup,
  BizhouError,
  normalizeCloudPath,
  readBackups,
  removeBackup,
} from "@bizhou/core";
import type { CommonOpts } from "./commands.ts";
import { info, ok, out, warn } from "./render.ts";
import type { Runtime } from "./runtime.ts";

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
    // "run" 在 Task 3 加入
    default:
      throw new BizhouError("INVALID_ARG", `未知子命令：backup ${sub}（用 add/list/rm）`);
  }
}
