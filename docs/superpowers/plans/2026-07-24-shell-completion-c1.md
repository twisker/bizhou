# C1 · shell 补全 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bz completion <bash|zsh|powershell>` 输出补全脚本；静态补全命令/子命令/flag，本地动态补全 backup-id/account/shell（经隐藏 `bz __complete`，零联网零解锁），文件/目录槽走 shell 原生补全。

**Architecture:** 纯 CLI 层新增 `completion.ts`：单一命令规格表 `COMMANDS` 驱动三个纯函数生成器 + `cmdComplete`（本地动态候选）+ `cmdCompletion`（打印脚本）。`index.ts` 分发 `completion`（可见）与 `__complete`（隐藏）。核心库不改。

**Tech Stack:** TypeScript + Bun 测试；生成器为纯字符串拼接，零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-24-shell-completion-design.md`。**依赖：** `readBackups`（`@bizhou/core`）、`rt.accounts.listAccounts()` 均已存在、均本地。

## Global Constraints

- 纯 CLI 层，**核心库 `@bizhou/core` 不改**；零新增外部运行时依赖。
- `bz __complete` **只读本地状态**（backups.json / 本地账号）：任何分支**绝不** `resolveMk`/网络/`makeBackend`/弹密码；出错**静默输出空**（补全不刷屏报错）。
- 补全脚本与 `__complete` 输出**不含任何密钥/凭证**（只有命令名、flag、任务 id、账号名、shell 名）。
- 命令规格表是**单一真值来源**：新增命令/flag 必须同步到 `COMMANDS`；一致性测试守住。
- 版本号由 pre-commit `scripts/bump-version.sh` 自动处理，任务内**不手改** VERSION/package.json 版本。

---

### Task 1: 命令规格表 + 一致性测试

**Files:**
- Create: `packages/cli/src/completion.ts`（本任务先放类型 + `GLOBAL_FLAGS` + `COMMANDS` + `topLevelCommandNames()`）
- Test: `packages/cli/test/completion-spec.test.ts`

**Interfaces:**
- Produces:
  - `type ArgKind`（file/dir/subcommand/dynamic/cloud/none）
  - `interface FlagSpec { name: string; takesValue: boolean; valueArg?: ArgKind }`
  - `interface CommandSpec { name: string; flags: FlagSpec[]; args: ArgKind[]; subArgs?: Record<string, ArgKind[]> }`
  - `const GLOBAL_FLAGS: FlagSpec[]`
  - `const COMMANDS: CommandSpec[]`
  - `topLevelCommandNames(): string[]`

- [ ] **Step 1: 写失败测试** `packages/cli/test/completion-spec.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { COMMANDS, GLOBAL_FLAGS, topLevelCommandNames } from "../src/completion.ts";

// index.ts switch 里可分发的全部命令（含隐藏 completion；不含隐藏 __complete）。
// 新增命令时必须同步此列表与 COMMANDS，否则本测试红。
const KNOWN = [
  "init", "unlock", "lock", "passwd", "recover", "login", "logout", "account",
  "push", "pull", "mkdir", "ls", "info", "rm", "trash", "mv", "cp", "rename",
  "share", "preview", "backup", "daemon", "completion",
];

describe("命令规格表一致性", () => {
  test("COMMANDS 覆盖全部已知命令、无遗漏无多余", () => {
    const names = topLevelCommandNames().sort();
    expect(names).toEqual([...KNOWN].sort());
  });

  test("push 命令的 flag 覆盖关键项", () => {
    const push = COMMANDS.find((c) => c.name === "push");
    const flags = push?.flags.map((f) => f.name) ?? [];
    for (const f of ["--to", "--chunk", "--compress", "--no-split", "--name", "--preview", "--force", "--concurrency"]) {
      expect(flags).toContain(f);
    }
    // push 第一个位置参数是文件槽
    expect(push?.args[0]?.kind).toBe("file");
  });

  test("backup 子命令与其二级参数正确", () => {
    const backup = COMMANDS.find((c) => c.name === "backup");
    expect(backup?.args[0]).toEqual({ kind: "subcommand", names: ["add", "list", "rm", "run"] });
    expect(backup?.subArgs?.add?.[0]?.kind).toBe("dir");
    expect(backup?.subArgs?.rm?.[0]).toEqual({ kind: "dynamic", ctx: "backup-id" });
    expect(backup?.subArgs?.run?.[0]).toEqual({ kind: "dynamic", ctx: "backup-id" });
  });

  test("completion 参数是 shell 动态槽；account use 是 account 动态槽", () => {
    expect(COMMANDS.find((c) => c.name === "completion")?.args[0]).toEqual({ kind: "dynamic", ctx: "shell" });
    expect(COMMANDS.find((c) => c.name === "account")?.subArgs?.use?.[0]).toEqual({ kind: "dynamic", ctx: "account" });
  });

  test("GLOBAL_FLAGS 含 --help/--local", () => {
    const g = GLOBAL_FLAGS.map((f) => f.name);
    expect(g).toContain("--help");
    expect(g).toContain("--local");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/completion-spec.test.ts`
Expected: FAIL（`completion.ts` 不存在）

- [ ] **Step 3: 实现规格表** `packages/cli/src/completion.ts`

```ts
/**
 * shell 补全：单一命令规格表 + 三 shell 生成器 + __complete 本地动态候选。
 * 纯 CLI 层，核心库不改。__complete 只读本地、绝不联网/解锁。
 */

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
    flags: [F("--code"), F("--7z"), F("--out", true, DIR), F("--ttl", true)],
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/test/completion-spec.test.ts`
Expected: PASS（5 测试）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/completion.ts packages/cli/test/completion-spec.test.ts`

```bash
git add packages/cli/src/completion.ts packages/cli/test/completion-spec.test.ts
git commit -m "feat(cli): shell 补全命令规格表（单一真值来源）+ 一致性测试"
```

---

### Task 2: `bz __complete` 本地动态候选

**Files:**
- Modify: `packages/cli/src/completion.ts`（新增 `cmdComplete`）
- Modify: `packages/cli/src/index.ts`（隐藏分发 `__complete`）
- Test: `packages/cli/test/complete-local.test.ts`

**Interfaces:**
- Consumes: `readBackups`（`@bizhou/core`）、`rt.accounts.listAccounts()`。
- Produces: `cmdComplete(rt, ctx: string, prefix?: string): Promise<void>` —— 逐行打印候选到 stdout；**只读本地、绝不联网/解锁**；出错或未知 ctx → 静默无输出（不抛）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/complete-local.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBackup } from "@bizhou/core";
import { cmdComplete } from "../src/completion.ts";

/** 捕获 stdout（cmdComplete 用 process.stdout.write 或 console.log 逐行输出）。 */
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-expect-error 覆盖签名足够测试
  process.stdout.write = (chunk: string) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines;
}

describe("bz __complete 本地动态", () => {
  test("shell → bash zsh powershell", async () => {
    const rt = {} as never; // shell 分支不碰 rt
    const out = await capture(() => cmdComplete(rt, "shell"));
    expect(out).toEqual(expect.arrayContaining(["bash", "zsh", "powershell"]));
  });

  test("backup-id → backups.json 的 id", async () => {
    const keyRoot = await mkdtemp(join(tmpdir(), "bizhou-cmpl-"));
    try {
      const a = await addBackup(keyRoot, { localDir: "/x", addedAt: "t" });
      const b = await addBackup(keyRoot, { localDir: "/y", addedAt: "t" });
      const rt = { paths: { dir: keyRoot } } as never;
      const out = await capture(() => cmdComplete(rt, "backup-id"));
      expect(out).toContain(a.id);
      expect(out).toContain(b.id);
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
    }
  });

  test("account → 账号名（stub listAccounts）", async () => {
    const rt = {
      accounts: { listAccounts: async () => ({ names: ["alice", "bob"], current: "alice" }) },
    } as never;
    const out = await capture(() => cmdComplete(rt, "account"));
    expect(out).toEqual(expect.arrayContaining(["alice", "bob"]));
  });

  test("未知 ctx → 无输出、不抛", async () => {
    const rt = {} as never;
    const out = await capture(() => cmdComplete(rt, "nonsense"));
    expect(out).toEqual([]);
  });

  test("出错（backups 读失败）→ 静默无输出、不抛，且不触发解锁/网络", async () => {
    // paths.dir 指向不可读/不存在处；断言不抛且无输出
    const rt = { paths: { dir: "/nonexistent-xyz- " } } as never;
    const out = await capture(() => cmdComplete(rt, "backup-id"));
    expect(out).toEqual([]); // readBackups 对缺失返回 []（无 id）→ 无输出
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/complete-local.test.ts`
Expected: FAIL（`cmdComplete` 不存在）

- [ ] **Step 3: 实现 `cmdComplete`（`completion.ts`）**

```ts
import { readBackups } from "@bizhou/core";
import type { Runtime } from "./runtime.ts";

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
```

> **实现者注意**：`Runtime` 里 `accounts.listAccounts` 与 `paths.dir` 已存在。`shell` 分支不触碰 `rt`（测试用空 rt）。确认 `readBackups` 对不存在 keyRoot 返回 `[]`（D1-T1 已保证 ENOENT→[]）。

- [ ] **Step 4: `index.ts` 隐藏分发 `__complete`**

在 `index.ts` 的 `switch (cmd)` 里加（**不进 HELP**）：

```ts
    case "__complete":
      await cmdComplete(rt, positionals[1] ?? "", positionals[2]);
      return 0;
```

从 `./completion.ts` 引入 `cmdComplete`。

- [ ] **Step 5: 运行测试 + 回归**

Run: `bun test packages/cli/test/complete-local.test.ts && bun test`
Expected: 新测试 PASS；无回归。

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/completion.ts packages/cli/src/index.ts packages/cli/test/complete-local.test.ts`

```bash
git add packages/cli/src/completion.ts packages/cli/src/index.ts packages/cli/test/complete-local.test.ts
git commit -m "feat(cli): bz __complete 本地动态候选（backup-id/account/shell，零联网零解锁）"
```

---

### Task 3: 三 shell 生成器（纯函数）

**Files:**
- Modify: `packages/cli/src/completion.ts`（新增 `genBash`/`genZsh`/`genPowerShell`）
- Test: `packages/cli/test/completion-gen.test.ts`

**Interfaces:**
- Produces: `genBash(): string`、`genZsh(): string`、`genPowerShell(): string`（纯函数，读 `COMMANDS`/`GLOBAL_FLAGS` 常量，无副作用）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/completion-gen.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { genBash, genPowerShell, genZsh, topLevelCommandNames } from "../src/completion.ts";

describe("shell 生成器", () => {
  test("genBash：含 complete 指令、全部命令、示例 flag、动态与文件槽 hook", () => {
    const s = genBash();
    expect(s).toContain("complete -F _bz bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("--compress"); // push 的 flag
    expect(s).toContain("bz __complete backup-id"); // 动态槽
    expect(s).toContain("_filedir"); // 文件/目录槽走原生
  });

  test("genZsh：含 #compdef、全部命令、动态槽、_files", () => {
    const s = genZsh();
    expect(s).toContain("#compdef bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("bz __complete");
    expect(s).toContain("_files");
  });

  test("genPowerShell：含 Register-ArgumentCompleter、全部命令、动态槽", () => {
    const s = genPowerShell();
    expect(s).toContain("Register-ArgumentCompleter");
    expect(s).toContain("-CommandName bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("bz __complete");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/completion-gen.test.ts`
Expected: FAIL（生成器不存在）

- [ ] **Step 3: 实现生成器（`completion.ts`）**

> 生成器把规格表编译为各 shell 的补全脚本。以下实现产出可用脚本且满足测试断言的关键子串；shell 内真实 tab 行为按 H-登记手动验证，实现者可在保持这些子串与结构的前提下微调转义细节。

```ts
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
/** 某命令（或其子命令）当前位置参数需要哪种动态/文件补全。 */
function dynamicCtxFor(cmd: string, sub?: string): { kind: "dynamic"; ctx: string } | { kind: "file" } | { kind: "dir" } | undefined {
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
  // 每个"有子命令或动态/文件槽"的命令生成一段 case 分支
  const perCmd = COMMANDS.map((c) => {
    const subs = subNamesFor(c.name);
    const dyn = dynamicCtxFor(c.name);
    const lines: string[] = [];
    if (subs) {
      // 二级：先补子命令；已选定子命令后按 subArgs 补
      lines.push(`      if [ "$cword" -eq 2 ]; then COMPREPLY=( $(compgen -W "${subs} ${flagsFor(c.name)}" -- "$cur") ); return; fi`);
      for (const sub of (COMMANDS.find((x) => x.name === c.name)?.args[0] as { names: string[] }).names) {
        const d = dynamicCtxFor(c.name, sub);
        if (d?.kind === "dynamic") lines.push(`      if [ "\${words[2]}" = "${sub}" ]; then COMPREPLY=( $(compgen -W "$(bz __complete ${d.ctx} "$cur")" -- "$cur") ); return; fi`);
        else if (d?.kind === "dir") lines.push(`      if [ "\${words[2]}" = "${sub}" ]; then _filedir -d; return; fi`);
        else if (d?.kind === "file") lines.push(`      if [ "\${words[2]}" = "${sub}" ]; then _filedir; return; fi`);
      }
    } else if (dyn?.kind === "dynamic") {
      lines.push(`      COMPREPLY=( $(compgen -W "$(bz __complete ${dyn.ctx} "$cur")" -- "$cur") ); return;`);
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
  const perCmd = COMMANDS.map((c) => {
    const subs = subNamesFor(c.name);
    const dyn = dynamicCtxFor(c.name);
    const body: string[] = [];
    if (subs) {
      body.push(`      if (( CURRENT == 2 )); then compadd ${subs}; return; fi`);
      for (const sub of (COMMANDS.find((x) => x.name === c.name)?.args[0] as { names: string[] }).names) {
        const d = dynamicCtxFor(c.name, sub);
        if (d?.kind === "dynamic") body.push(`      [[ "\${words[2]}" == "${sub}" ]] && { compadd \${(f)"$(bz __complete ${d.ctx})"}; return; }`);
        else if (d?.kind === "dir") body.push(`      [[ "\${words[2]}" == "${sub}" ]] && { _files -/; return; }`);
        else if (d?.kind === "file") body.push(`      [[ "\${words[2]}" == "${sub}" ]] && { _files; return; }`);
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
  local -a words; words=("\${words[@]}")
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
    if (subs) parts.push(`subs = @(${subs.split(" ").map((s) => `'${s}'`).join(", ")})`);
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
```

> **实现者注意**：以上生成器需产出满足 Task 3 测试断言的关键子串（`complete -F _bz bz` / `#compdef bz` / `Register-ArgumentCompleter` / `-CommandName bz` / 全部命令名 / `--compress` / `bz __complete <ctx>` / `_filedir` / `_files`）。若微调转义或结构，务必保持这些子串存在。生成脚本的真实 shell tab 行为登记为人工验证。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/test/completion-gen.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/completion.ts packages/cli/test/completion-gen.test.ts`

```bash
git add packages/cli/src/completion.ts packages/cli/test/completion-gen.test.ts
git commit -m "feat(cli): bash/zsh/PowerShell 补全脚本生成器（纯函数，规格表驱动）"
```

---

### Task 4: `bz completion <shell>` 命令 + 分发 + HELP

**Files:**
- Modify: `packages/cli/src/completion.ts`（新增 `cmdCompletion`）
- Modify: `packages/cli/src/index.ts`（分发 `completion` + HELP）
- Test: `packages/cli/test/completion-cmd.test.ts`

**Interfaces:**
- Produces: `cmdCompletion(shell: string | undefined): void` —— 校验 shell ∈ {bash,zsh,powershell}，打印对应脚本到 stdout；非法/缺省 → 抛 `BizhouError` 列出支持项。

- [ ] **Step 1: 写失败测试** `packages/cli/test/completion-cmd.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { cmdCompletion } from "../src/completion.ts";

async function capture(fn: () => void): Promise<string> {
  let buf = "";
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-expect-error 测试覆盖
  process.stdout.write = (chunk: string) => {
    buf += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

describe("bz completion <shell>", () => {
  test("bash → 打印 bash 脚本", async () => {
    const out = await capture(() => cmdCompletion("bash"));
    expect(out).toContain("complete -F _bz bz");
  });
  test("zsh → 打印 zsh 脚本", async () => {
    const out = await capture(() => cmdCompletion("zsh"));
    expect(out).toContain("#compdef bz");
  });
  test("powershell → 打印 PowerShell 脚本", async () => {
    const out = await capture(() => cmdCompletion("powershell"));
    expect(out).toContain("Register-ArgumentCompleter");
  });
  test("非法/缺省 shell → 抛错列支持项", () => {
    expect(() => cmdCompletion("fish")).toThrow();
    expect(() => cmdCompletion(undefined)).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/completion-cmd.test.ts`
Expected: FAIL（`cmdCompletion` 不存在）

- [ ] **Step 3: 实现 `cmdCompletion`（`completion.ts`）**

```ts
import { BizhouError } from "@bizhou/core";

/** 打印指定 shell 的补全脚本到 stdout；stderr 打安装提示。 */
export function cmdCompletion(shell: string | undefined): void {
  switch (shell) {
    case "bash":
      process.stdout.write(genBash());
      break;
    case "zsh":
      process.stdout.write(genZsh());
      break;
    case "powershell":
      process.stdout.write(genPowerShell());
      break;
    default:
      throw new BizhouError(
        "INVALID_ARG",
        `用法：bz completion <bash|zsh|powershell>（不支持：${shell ?? "（空）"}）`,
      );
  }
}
```

- [ ] **Step 4: `index.ts` 分发 `completion` + HELP**

`switch (cmd)` 加：

```ts
    case "completion":
      cmdCompletion(positionals[1]);
      return 0;
```

从 `./completion.ts` 引入 `cmdCompletion`。HELP 增：

```
其它:
  completion <bash|zsh|powershell>   输出 shell 补全脚本（eval 或写入 rc 文件）
```

- [ ] **Step 5: 运行测试 + 全量回归 + 构建**

Run: `bun test packages/cli/test/completion-cmd.test.ts && bun test && pnpm run build`
Expected: 全绿；构建通过。

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/completion.ts packages/cli/src/index.ts packages/cli/test/completion-cmd.test.ts`

```bash
git add packages/cli/src/completion.ts packages/cli/src/index.ts packages/cli/test/completion-cmd.test.ts
git commit -m "feat(cli): bz completion <shell> 命令 + 分发 + HELP"
```

---

## 收尾（所有任务后）

- [ ] 全量 `bun test` + `pnpm run typecheck` + `npx biome check .` + `pnpm run build` 全绿。
- [ ] **手动/集成验证**（真机）：`eval "$(bz completion bash)"`（或 zsh/PowerShell）后 tab 补全命令/flag/backup-id/account/文件路径；记录到报告，人工登记（`人工TODO事项.md` 增 C1 shell tab 手动验证项）。
- [ ] 更新 `.claude/current-sprint.md`、`.claude/module-spec-registry.md`（completion）、`.claude/test-registry.md`（completion-spec/complete-local/completion-gen/completion-cmd）、`.claude/sprint-plan.md`（Phase 3 · C1 完成）。
- [ ] 交由人工按 git flow 处理（本计划不 push）。

## 自审记录

- **Spec 覆盖**：规格表单一真值（T1）/ 本地动态零联网零解锁（T2）/ 三生成器（T3）/ completion 命令（T4）/ 文件槽走原生（生成器内 `_filedir`/`_files`/PowerShell 默认）/ 云端槽预留 `cloud` kind 不补。
- **类型一致**：`ArgKind`/`CommandSpec` 全程一致；`cmdComplete`/`cmdCompletion` 签名 T2/T4 一致；生成器纯函数无参。
- **无占位符**：各步含完整测试与实现代码；shell 脚本真实 tab 行为明确登记为手动验证、自动化测关键子串与本地逻辑。
- **安全**：`__complete` 只读本地、出错静默空、绝不解锁/联网；输出无密钥。核心库不改。
- **一致性守护**：T1 的 KNOWN 列表 vs `topLevelCommandNames()` 断言——新增命令若漏进 COMMANDS，测试立即红。
