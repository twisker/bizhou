# shell 补全 设计（Phase 3 · C1）

> 状态：已认可，待落实现计划。日期：2026-07-24。
> 归属：路线图 Phase 3「打磨与生态」候选「shell 补全」。

## 背景与动机

`bz` 命令面已完整（22 个顶层命令 + account/trash/backup 子命令 + 一批 flag）。为 CLI 提供 tab 补全是用户可感的打磨：少记命令、少查 HELP、少打错。

## 目标

- **C-G1 三 shell 补全**：`bz completion <bash|zsh|powershell>` 输出对应 shell 的补全脚本。
- **C-G2 静态补全**：命令、子命令、每命令的 flag，内嵌进脚本，补全瞬时、不起子进程。
- **C-G3 本地动态补全**：`backup-id` / `account` 名 / `shell` 名等**只读本地状态**的候选，经隐藏命令 `bz __complete <上下文>` 产出——**绝不联网、绝不弹密码、绝不阻塞**。
- **C-G4 文件/目录槽走 shell 原生补全**：`push <path>` / `backup add <dir>` / `--out <dir>` 等交给 bash `_filedir` / zsh `_files` / PowerShell 默认，不走 `__complete`。
- **C-G5 单一真值来源**：一张命令规格表驱动三个生成器与 `__complete`——加命令/flag 只改一处。

**非目标（本轮）**：fish（用户未选）；**云端动态补全**（bundle id / 云端路径——需联网列目录 + 解锁显真名，tab 补全时卡顿、体验差）；补全脚本的自动安装（用户自行 `eval`/重定向，仅打印安装提示）。规格表预留云端槽位类型，将来接 `bz __complete cloud-*` 即可。

## 关键设计

### 命令规格表（单一真值来源）

```ts
type ArgKind =
  | { kind: "file" }            // shell 原生文件补全
  | { kind: "dir" }             // shell 原生目录补全
  | { kind: "dynamic"; ctx: "backup-id" | "account" | "shell" }  // 调 bz __complete <ctx>
  | { kind: "subcommand"; names: string[] };                     // 固定子命令集

interface FlagSpec { name: string; takesValue: boolean; valueArg?: ArgKind } // 如 --to（takesValue, 无补全）/--out（dir）
interface CommandSpec {
  name: string;
  flags: FlagSpec[];        // 该命令可用 flag（不含全局 --help/--verbose 等，见下）
  args: ArgKind[];          // 位置参数按序（子命令算 args[0] 的 subcommand 类型）
}
const GLOBAL_FLAGS: FlagSpec[];  // 所有命令通用：--help、--verbose、--password-stdin、--local 等
const COMMANDS: CommandSpec[];   // 覆盖 index.ts 的每一个 case
```

规格表覆盖全部命令。例：
- `push`：args=[{file}]，flags=[--to(无补全值), --chunk, --compress, --no-split, --name, --preview, --force, --concurrency]
- `backup`：args=[{subcommand: [add,list,rm,run]}]；`add` 后 args=[{dir}] + --to；`rm`/`run` 后 args=[{dynamic:backup-id}]
- `account`：args=[{subcommand:[list,use,add]}]；`use` 后 args=[{dynamic:account}]
- `pull`：args=[{...云端槽（本轮不补，占位）}]，flags=[--out(dir), --force]
- `completion`：args=[{dynamic:shell}]

> 子命令的二级 args（如 `backup add <dir>`）在规格里用嵌套：`subcommandArgs: Record<string, ArgKind[]>`。以简单清晰为准，实现时按此结构。

### 隐藏命令 `bz __complete <ctx> [已输入前缀]`

- 契约：把候选逐行输出到 stdout；无候选则输出空。**只读本地**：
  - `backup-id` → `readBackups(rt.paths.dir)` 的 id（+可带 localDir 作说明，视 shell 支持）。
  - `account` → `rt.accounts.listAccounts().names`。
  - `shell` → `bash zsh powershell`。
- **硬约束**：`__complete` 任何分支都不得调用 `resolveMk`/网络/`makeBackend`；出错时静默输出空（补全不该报错刷屏）。
- `__complete` 不进 HELP（隐藏），但正常可跑。

### 三 shell 生成器（纯函数：规格表 → 脚本字符串）

- `genBash(spec)`：`complete -F _bz bz`；`_bz` 用 `COMPREPLY`/`compgen -W` 补静态词，`_filedir`/`_filedir -d` 补文件/目录，`$(bz __complete <ctx> "$cur")` 补动态。
- `genZsh(spec)`：`#compdef bz` + `_arguments`/`_describe`；动态槽 `compadd $(bz __complete <ctx>)`；文件 `_files`/`_files -/`。
- `genPowerShell(spec)`：`Register-ArgumentCompleter -CommandName bz -ScriptBlock {...}`；解析已输入 token 定位命令/子命令，静态词过滤前缀，动态槽调 `bz __complete <ctx>`，文件槽用 PowerShell 默认。

### `bz completion <shell>`

- 校验 shell ∈ {bash,zsh,powershell}，否则报错列出支持项。
- 打印对应生成器输出到 stdout；stderr 打安装提示（如 bash：`# 安装：eval "$(bz completion bash)"（加入 ~/.bashrc）`）。

## 文件结构

**CLI `bz`：**
- 新增 `packages/cli/src/completion.ts` —— 类型 + `GLOBAL_FLAGS` + `COMMANDS` 规格表 + `genBash`/`genZsh`/`genPowerShell`（纯函数）+ `cmdCompletion(rt, shell)` + `cmdComplete(rt, ctx, prefix)`。
- 修改 `packages/cli/src/index.ts` —— 分发 `completion <shell>`（可见）与 `__complete`（隐藏）；HELP 增 `completion`。

**核心库**：无改动（补全纯 CLI 层；`readBackups`/`listAccounts` 已存在）。

## 测试策略（TDD，先写失败测试）

**规格表一致性（`completion`）**
- `COMMANDS` 覆盖 `index.ts` 每个命令 case——用一份"已知命令列表"断言无遗漏、无多余（防新增命令漏补全）。

**`bz __complete`（`cmdComplete`）**
- `backup-id` → 输出 backups.json 的 id（先 add 两个任务，断言两 id 都在输出）。
- `account` → 输出账号名（mock/临时账号状态）。
- `shell` → 输出 `bash zsh powershell`。
- **安全断言**：用一个不含账号、不联网的最小 rt 跑各 ctx，断言**不抛、不阻塞**（不触发 resolveMk/网络）；未知 ctx → 空输出。

**三生成器（`genBash`/`genZsh`/`genPowerShell`）**
- 输出非空且含该 shell 关键指令：`complete -F` / `#compdef` / `Register-ArgumentCompleter`。
- 含全部顶层命令名；抽查某命令的 flag（如 `push` 含 `--compress`）出现在脚本里。
- 动态槽正确挂到 `bz __complete <ctx>`（脚本字符串里含该调用）。
- 文件/目录槽挂到该 shell 的原生文件补全指令。

**（真实 shell 内的 tab 行为 = 手动/集成验证，登记人工。）**

## 里程碑拆分（约 4 个 TDD 任务）

- **C1-T1**：命令规格表（类型 + `GLOBAL_FLAGS` + `COMMANDS`）+ 与 index.ts 命令集一致性测试。
- **C1-T2**：`bz __complete`（`cmdComplete`，本地动态：backup-id/account/shell，零联网零解锁）+ 隐藏分发。
- **C1-T3**：三 shell 生成器（`genBash`/`genZsh`/`genPowerShell` 纯函数）+ 生成器测试。
- **C1-T4**：`bz completion <shell>` 命令 + `index.ts` 分发 + HELP。

## 安全红线自检

- `__complete` **只读本地**（backups.json / 本地账号），绝不 `resolveMk`/网络/弹密码；出错静默空输出。
- 补全脚本与 `__complete` 输出**不含任何密钥/凭证**（只有命令名、flag、任务 id、账号名、shell 名）。
- 零新增外部运行时依赖（生成器为纯字符串拼接）。
- 纯 CLI 层，核心库不改。

## 追记：C1 最终评审 Important 修复（genPowerShell 补齐 flag/文件/前缀补全）

- 最终评审发现 `genPowerShell` 落后于 bash/zsh：只补顶层命令名与（末尾带空格的）子命令，**不补 flag、不补文件/目录、部分子命令走前缀输入会失效**（如 `bz account u<TAB>` 补不出 `use`）。
- 修复后 `$script:BzSpec` 按命令内嵌 `flags`（命令自身 + `GLOBAL_FLAGS`，复用既有 `flagsFor` 去重）、顶层 `argKind`（`file`/`dir`/`dynamic`）及子命令级 `subKind`/`subCtx`，与 `genBash`/`genZsh` 同源于 `COMMANDS` 表，不写死分支。
- `Register-ArgumentCompleter -Native` 会抑制 PowerShell 默认路径补全，因此 file/dir 槽由脚本块显式调用 `[System.Management.Automation.CompletionCompleters]::CompleteFilename($wordToComplete)` 产出候选（`push` 文件槽、`backup add` 目录槽已覆盖；`mkdir`/`ls` 等云端槽仍按设计本轮不补）。
- 子命令/flag 均改为按 `$wordToComplete` 用 `-like "$wordToComplete*"` 前缀过滤，位置判定基于"已确定输入的 token 数"（剔除正在补全中的当前词后计数），而非旧版 `tokens.Count -le 2` 的严格相等判断，解决部分输入子命令名时补全失效的问题。
- value-flag 的值补全（如 `--out` → dir）与 bash/zsh 一致标注 `TODO(C1 follow-up)`，留作后续任务。
- **未执行验证**：本机无 `pwsh` 二进制，无法像 bash/zsh 那样跑执行级回归测试（source 脚本 + 模拟补全 widget 调用）。`completion-gen.test.ts` 仅能做字符串/结构断言（含 flag 名、`CompleteFilename`、`-like` 等）。**真实 pwsh 会话内的 tab 行为需要人工验证**，已在 `人工TODO事项.md` 登记。
