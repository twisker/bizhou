/**
 * 跨平台递归文件监听 + 防抖。
 * darwin/win32：fs.watch(dir, {recursive:true})（单个 watcher，若抛出则回退到逐目录 watch）；
 * linux：不支持 recursive，walk 后逐目录 watch（新建的深层目录尽力而为——仅在下次事件/进程重启时补扫，
 *   daemon 的定时 sweep 负责兜底覆盖遗漏的变更）。
 * 不依赖 commands.ts/daemon.ts，可独立测试。
 */

import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export function debounce<T extends unknown[]>(
  fn: (...a: T) => void,
  ms: number,
): { call: (...a: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: T | undefined;
  return {
    call: (...args: T) => {
      lastArgs = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (lastArgs) fn(...lastArgs);
      }, ms);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** 列出 root 及其下所有子目录（含 root）。忽略无法读取的目录。 */
export async function listDirsRecursive(root: string): Promise<string[]> {
  const dirs: string[] = [root];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = join(dir, e.name);
        dirs.push(sub);
        await walk(sub);
      }
    }
  };
  await walk(root);
  return dirs;
}

export interface Watcher {
  stop(): void;
}

/** 递归监听 dir；任何变更事件经防抖后调用 onChange。 */
export function watchRecursive(
  dir: string,
  onChange: () => void,
  opts: { debounceMs: number; platform?: NodeJS.Platform },
): Watcher {
  const plat = opts.platform ?? process.platform;
  const d = debounce(onChange, opts.debounceMs);
  const watchers: FSWatcher[] = [];
  let stopped = false;
  const safeWatch = (target: string): void => {
    if (stopped) return; // 已 stop()：异步注册回调迟到，不再开句柄（防泄漏 inotify FD/卡住退出）
    try {
      watchers.push(watch(target, () => d.call()));
    } catch {
      /* 目标消失/权限：忽略，定时兜底覆盖 */
    }
  };

  if (plat === "darwin" || plat === "win32") {
    // 只注册一个 recursive watcher；若 {recursive:true} 不受支持/抛出，回退到逐目录 watch，
    // 避免同时注册递归 + 非递归导致同一事件被防抖回调重复触发。
    try {
      watchers.push(watch(dir, { recursive: true }, () => d.call()));
    } catch {
      void listDirsRecursive(dir).then((dirs) => {
        for (const sub of dirs) safeWatch(sub);
      });
    }
  } else {
    // linux：fs.watch 不支持 recursive，逐目录监听（当前快照）；
    // 新建的深层子目录不会被自动追加监听——依赖 daemon 的定时 sweep 兜底覆盖遗漏的变更。
    void listDirsRecursive(dir).then((dirs) => {
      for (const sub of dirs) safeWatch(sub);
    });
  }

  return {
    stop() {
      stopped = true; // 阻止迟到的异步 safeWatch 再开句柄
      d.cancel();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
