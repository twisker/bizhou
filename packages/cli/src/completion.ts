/**
 * shell 补全：单一命令规格表 + 三 shell 生成器 + __complete 本地动态候选。
 * 纯 CLI 层，核心库不改。__complete 只读本地、绝不联网/解锁。
 */

import { readBackups } from "@bizhou/core";
import type { Runtime } from "./runtime.ts";

export type ArgKind =
  | { kind: "file" } // shell 原生文件补全
  | { kind: "dir" } // shell 原生目录补全
  | { kind: "subcommand"; names: string[] } // 固定子命令集
  | { kind: "dynamic"; ctx: "backup-id" | "account" | "shell" } // 调 bz __complete <ctx>
  | { kind: "cloud"; ctx: "bundle-id" | "cloud-dir" } // 预留：本轮不补（联网/解锁）
  | { kind: "none" }; // 无补全

export interface FlagSpec {
  name: string; // "--to"
  takesValue: boolean;
  valueArg?: ArgKind; // 取值 flag 的值补全（如 --out → dir）
}

export interface CommandSpec {
  name: string;
  flags: FlagSpec[];
  args: ArgKind[]; // 位置参数按序
  subArgs?: Record<string, ArgKind[]>; // 子命令名 → 其二级位置参数
}

const F = (name: string, takesValue = false, valueArg?: ArgKind): FlagSpec => ({
  name,
  takesValue,
  ...(valueArg ? { valueArg } : {}),
});

/** 所有命令通用 flag。 */
export const GLOBAL_FLAGS: FlagSpec[] = [
  F("--help"),
  F("--version"),
  F("--local", true, { kind: "dir" }),
  F("--password-stdin"),
];

const FILE: ArgKind = { kind: "file" };
const DIR: ArgKind = { kind: "dir" };
const CLOUD_ID: ArgKind = { kind: "cloud", ctx: "bundle-id" };
const CLOUD_DIR: ArgKind = { kind: "cloud", ctx: "cloud-dir" };

export const COMMANDS: CommandSpec[] = [
  { name: "init", flags: [F("--force")], args: [] },
  { name: "unlock", flags: [F("--ttl", true)], args: [] },
  { name: "lock", flags: [], args: [] },
  { name: "passwd", flags: [], args: [] },
  { name: "recover", flags: [], args: [] },
  {
    name: "login",
    flags: [F("--name", true), F("--device"), F("--port", true)],
    args: [],
  },
  { name: "logout", flags: [], args: [] },
  {
    name: "account",
    flags: [],
    args: [{ kind: "subcommand", names: ["list", "use", "add"] }],
    subArgs: { use: [{ kind: "dynamic", ctx: "account" }], add: [{ kind: "none" }], list: [] },
  },
  {
    name: "push",
    flags: [
      F("--to", true),
      F("--chunk", true),
      F("--compress"),
      F("--no-split"),
      F("--name", true),
      F("--preview"),
      F("--force"),
      F("--concurrency", true),
      F("--recursive"),
    ],
    args: [FILE],
  },
  {
    name: "pull",
    flags: [F("--out", true, DIR), F("--recursive"), F("--force")],
    args: [CLOUD_ID],
  },
  { name: "mkdir", flags: [], args: [CLOUD_DIR] },
  { name: "ls", flags: [F("--recursive")], args: [CLOUD_DIR] },
  { name: "info", flags: [], args: [CLOUD_ID] },
  { name: "rm", flags: [F("--yes")], args: [CLOUD_ID] },
  {
    name: "trash",
    flags: [],
    args: [{ kind: "subcommand", names: ["list", "restore", "rm", "clear"] }],
    // restore/rm 的回收站条目 id 需后端（本轮不补，走 none）
    subArgs: { restore: [{ kind: "none" }], rm: [{ kind: "none" }], list: [], clear: [] },
  },
  { name: "mv", flags: [], args: [CLOUD_ID, CLOUD_DIR] },
  { name: "cp", flags: [F("--recursive")], args: [CLOUD_ID, CLOUD_DIR] },
  { name: "rename", flags: [], args: [CLOUD_ID, { kind: "none" }] },
  {
    name: "share",
    // 注：cmdShare 当前只读 --code/--7z/--out（不含 --ttl）；补全须贴合实际，避免提示无效 flag。
    flags: [F("--code"), F("--7z"), F("--out", true, DIR)],
    args: [CLOUD_ID],
  },
  { name: "preview", flags: [F("--out", true, DIR)], args: [CLOUD_ID] },
  {
    name: "backup",
    flags: [F("--to", true)],
    args: [{ kind: "subcommand", names: ["add", "list", "rm", "run"] }],
    subArgs: {
      add: [DIR],
      list: [],
      rm: [{ kind: "dynamic", ctx: "backup-id" }],
      run: [{ kind: "dynamic", ctx: "backup-id" }],
    },
  },
  { name: "daemon", flags: [], args: [] },
  { name: "completion", flags: [], args: [{ kind: "dynamic", ctx: "shell" }] },
];

export function topLevelCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/**
 * 隐藏命令 bz __complete <ctx> [prefix]：逐行打印本地动态候选。
 * 只读本地状态；绝不 resolveMk/网络/makeBackend。任何异常静默吞掉（补全不该报错刷屏）。
 */
export async function cmdComplete(rt: Runtime, ctx: string, prefix?: string): Promise<void> {
  let candidates: string[] = [];
  try {
    switch (ctx) {
      case "shell":
        candidates = ["bash", "zsh", "powershell"];
        break;
      case "backup-id":
        candidates = (await readBackups(rt.paths.dir)).map((j) => j.id);
        break;
      case "account":
        candidates = (await rt.accounts.listAccounts()).names;
        break;
      default:
        candidates = []; // 未知/预留（cloud-*）→ 空
    }
  } catch {
    candidates = []; // 静默：补全场景不抛
  }
  const p = prefix ?? "";
  for (const c of candidates) {
    if (c.startsWith(p)) process.stdout.write(`${c}\n`);
  }
}
