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

// ---------------------------------------------------------------------------
// 三 shell 生成器（纯函数）：把 COMMANDS/GLOBAL_FLAGS 规格表编译为各 shell 的补全脚本。
// 只读常量、返回字符串，无 I/O、无副作用。真实 shell 内 tab 行为按登记手动验证。
// ---------------------------------------------------------------------------

function allCommandNames(): string {
  return COMMANDS.map((c) => c.name).join(" ");
}

function flagsFor(name: string): string {
  const c = COMMANDS.find((x) => x.name === name);
  const flags = [...(c?.flags ?? []), ...GLOBAL_FLAGS].map((f) => f.name);
  return [...new Set(flags)].join(" ");
}

function subNamesFor(name: string): string | undefined {
  const a = COMMANDS.find((x) => x.name === name)?.args[0];
  return a?.kind === "subcommand" ? a.names.join(" ") : undefined;
}

/** 某命令的子命令名列表（若无子命令则空数组，安全兜底）。 */
function subNameList(name: string): string[] {
  const a = COMMANDS.find((x) => x.name === name)?.args[0];
  return a?.kind === "subcommand" ? a.names : [];
}

/** 某命令（或其子命令）当前位置参数需要哪种动态/文件补全。 */
function dynamicCtxFor(
  cmd: string,
  sub?: string,
): { kind: "dynamic"; ctx: string } | { kind: "file" } | { kind: "dir" } | undefined {
  const c = COMMANDS.find((x) => x.name === cmd);
  if (!c) return undefined;
  const arg = sub ? c.subArgs?.[sub]?.[0] : c.args[0];
  if (!arg) return undefined;
  if (arg.kind === "dynamic") return { kind: "dynamic", ctx: arg.ctx };
  if (arg.kind === "file") return { kind: "file" };
  if (arg.kind === "dir") return { kind: "dir" };
  return undefined; // subcommand/cloud/none：无（cloud 预留）
}

export function genBash(): string {
  const cmds = allCommandNames();
  // TODO(C1 follow-up): value-flag valueArg completion (--out → dir) not yet wired
  // 每个"有子命令或动态/文件槽"的命令生成一段 case 分支
  const perCmd = COMMANDS.map((c) => {
    const subs = subNamesFor(c.name);
    const dyn = dynamicCtxFor(c.name);
    const lines: string[] = [];
    if (subs) {
      // 二级：先补子命令；已选定子命令后按 subArgs 补
      lines.push(
        `      if [ "$cword" -eq 2 ]; then COMPREPLY=( $(compgen -W "${subs} ${flagsFor(c.name)}" -- "$cur") ); return; fi`,
      );
      for (const sub of subNameList(c.name)) {
        const d = dynamicCtxFor(c.name, sub);
        if (d?.kind === "dynamic")
          lines.push(
            `      if [ "\${words[2]}" = "${sub}" ]; then COMPREPLY=( $(compgen -W "$(bz __complete ${d.ctx} "$cur")" -- "$cur") ); return; fi`,
          );
        else if (d?.kind === "dir")
          lines.push(`      if [ "\${words[2]}" = "${sub}" ]; then _filedir -d; return; fi`);
        else if (d?.kind === "file")
          lines.push(`      if [ "\${words[2]}" = "${sub}" ]; then _filedir; return; fi`);
      }
    } else if (dyn?.kind === "dynamic") {
      lines.push(
        `      COMPREPLY=( $(compgen -W "$(bz __complete ${dyn.ctx} "$cur")" -- "$cur") ); return;`,
      );
    } else if (dyn?.kind === "file") {
      lines.push(`      _filedir; return;`);
    } else if (dyn?.kind === "dir") {
      lines.push(`      _filedir -d; return;`);
    }
    lines.push(`      COMPREPLY=( $(compgen -W "${flagsFor(c.name)}" -- "$cur") ); return;`);
    return `    ${c.name})\n${lines.join("\n")}\n      ;;`;
  }).join("\n");

  return `# bash completion for bz —— 安装：eval "$(bz completion bash)"（写入 ~/.bashrc）
_bz() {
  local cur cword words
  _get_comp_words_by_ref -n : cur words cword 2>/dev/null || { cur="\${COMP_WORDS[COMP_CWORD]}"; words=("\${COMP_WORDS[@]}"); cword=$COMP_CWORD; }
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") ); return
  fi
  case "\${words[1]}" in
${perCmd}
  esac
}
complete -F _bz bz
`;
}

export function genZsh(): string {
  const cmds = allCommandNames();
  // TODO(C1 follow-up): value-flag valueArg completion (--out → dir) not yet wired
  const perCmd = COMMANDS.map((c) => {
    const subs = subNamesFor(c.name);
    const dyn = dynamicCtxFor(c.name);
    const body: string[] = [];
    if (subs) {
      // zsh $words 1-索引：words[1]=bz words[2]=command words[3]=subcommand
      body.push(`      if (( CURRENT == 3 )); then compadd ${subs}; return; fi`);
      for (const sub of subNameList(c.name)) {
        const d = dynamicCtxFor(c.name, sub);
        if (d?.kind === "dynamic")
          body.push(
            `      [[ "\${words[3]}" == "${sub}" ]] && { compadd \${(f)"$(bz __complete ${d.ctx})"}; return; }`,
          );
        else if (d?.kind === "dir")
          body.push(`      [[ "\${words[3]}" == "${sub}" ]] && { _files -/; return; }`);
        else if (d?.kind === "file")
          body.push(`      [[ "\${words[3]}" == "${sub}" ]] && { _files; return; }`);
      }
    } else if (dyn?.kind === "dynamic") {
      body.push(`      compadd \${(f)"$(bz __complete ${dyn.ctx})"}; return;`);
    } else if (dyn?.kind === "file") {
      body.push(`      _files; return;`);
    } else if (dyn?.kind === "dir") {
      body.push(`      _files -/; return;`);
    }
    body.push(`      compadd ${flagsFor(c.name)};`);
    return `    ${c.name})\n${body.join("\n")}\n      ;;`;
  }).join("\n");

  return `#compdef bz
# zsh completion for bz —— 安装：bz completion zsh > "\${fpath[1]}/_bz"（或 eval）
_bz() {
  # $words/$CURRENT 由 zsh 补全 widget 提供（1-索引：words[1]=bz words[2]=command）
  # 切勿 local -a words 重声明——会先掩蔽再赋值成空数组，令下方 case 全部落空。
  if (( CURRENT == 2 )); then
    compadd ${cmds}; return
  fi
  case "\${words[2]}" in
${perCmd}
  esac
}
compdef _bz bz
`;
}

export function genPowerShell(): string {
  const cmds = COMMANDS.map((c) => `'${c.name}'`).join(", ");
  // 每命令：子命令 + 动态 ctx（供脚本块按已输入 token 分派）
  const table = COMMANDS.map((c) => {
    const subs = subNamesFor(c.name);
    const dyn = dynamicCtxFor(c.name);
    const parts: string[] = [];
    if (subs)
      parts.push(
        `subs = @(${subs
          .split(" ")
          .map((s) => `'${s}'`)
          .join(", ")})`,
      );
    if (dyn?.kind === "dynamic") parts.push(`ctx = '${dyn.ctx}'`);
    // 子命令的动态槽
    const c2 = COMMANDS.find((x) => x.name === c.name);
    const subCtx = c2?.subArgs
      ? Object.entries(c2.subArgs)
          .map(([k, v]) => (v[0]?.kind === "dynamic" ? `'${k}'='${v[0].ctx}'` : ""))
          .filter(Boolean)
          .join("; ")
      : "";
    if (subCtx) parts.push(`subCtx = @{${subCtx}}`);
    return `    '${c.name}' = @{ ${parts.join("; ")} }`;
  }).join("\n");

  return `# PowerShell completion for bz —— 安装：bz completion powershell | Out-String | Invoke-Expression（写入 $PROFILE）
$script:BzSpec = @{
${table}
}
Register-ArgumentCompleter -Native -CommandName bz -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  if ($tokens.Count -le 1) {
    return @(${cmds}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  $cmd = $tokens[1]
  $spec = $script:BzSpec[$cmd]
  $cands = @()
  if ($spec) {
    if ($spec.subs -and $tokens.Count -le 2) { $cands += $spec.subs }
    elseif ($spec.subCtx -and $spec.subCtx[$tokens[2]]) { $cands += (bz __complete $spec.subCtx[$tokens[2]]) }
    elseif ($spec.ctx) { $cands += (bz __complete $spec.ctx) }
  }
  $cands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
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
