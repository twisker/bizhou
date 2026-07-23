# daemon / 定时备份 设计（Phase 3 · D1）

> 状态：已认可，待落实现计划。日期：2026-07-24。
> 归属：路线图 Phase 3「打磨与生态」候选「daemon/定时备份」。

## 背景与动机

敝帚本质是**客户端加密备份**工具。M1/v2/S1/S2 已提供：单文件与整树加密上传/下载、内容去重（contentId）、断点续传、在飞锁、原子落地。缺的是**无人值守的自动备份**——让用户"注册要备份的目录，之后改动自动加密上云"。

S1/S2 恰好把 daemon 变简单：daemon 只需对文件调 `pushOneFile`，**去重/续传/在飞锁自动兜底**（没变的文件秒跳过，改了的自动增量上传）。

## 目标

- **D-G1 注册式备份任务**：`bz backup add <本地目录> [--to <云端目录>]` 注册多个任务，持久化；`list`/`rm`/`run` 管理。
- **D-G2 幂等备份引擎**：唯一操作 `sweepJob(job)` = 遍历 localDir 逐文件 `pushOneFile` 到镜像云端位置。天然幂等（dedup 兜底），重复触发无害。
- **D-G3 双触发 daemon**：`bz daemon` 前台运行，启动即扫 + 实时监听（防抖）+ 定时兜底三触发，均只调 `sweepJob`；SIGINT/SIGTERM 优雅退出。
- **D-G4 备份语义（永不删云）**：本地删除**不**镜像到云端；daemon 只增/更，绝不删云端 bundle。清理云端靠人工 `bz rm`/`trash`。

**非目标（本轮）**：OS 服务单元安装（launchd/systemd/计划任务）——前台进程为主，用户自行后台化；镜像删除语义；下载方向的同步（daemon 只上行备份）；多机冲突协调。

## 关键设计

### 唯一操作：幂等的 `sweepJob`

一个"备份任务"：

```
BackupJob { id: string; localDir: string; cloudDir?: string; addedAt: string; lastBackupAt?: string }
```

`sweepJob(job)`：`walkLocalFiles(job.localDir)` → 对每个文件，云端落点 = 镜像（见下）→ 调 **S1 的 `pushOneFile`**（内容去重/续传/在飞锁全兜底）→ 累计 `{uploaded, skipped, failed}`。**单个文件失败被捕获、记录、继续**（一坏文件不中断整轮）。

云端镜像规则（**与 `cmdPushRecursive` 逐字一致**）：`baseCloud = job.cloudDir ? normalizeCloudPath(job.cloudDir) : defaultUploadCloudDir(localDir + sep, fileRoot)`；`rootCloud = joinCloudPath(baseCloud, basename(localDir))`（含目录名，故 fileRoot 外的源也保留目录名，不丢结构）；每个文件 `cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir)`，其中 `relDir = dirname(relative(localDir, file))`。

幂等性来自 S1：`pushOneFile` 预哈希 contentId → 目标云端目录已有相同内容则 `skipped-dup`。故 `sweepJob` 可被任意频繁触发，未变文件零上传。

### 三个触发器，共用 `sweepJob`

`bz daemon`（前台阻塞进程）：

1. **启动即扫**：对所有任务顺序 `sweepJob`，追赶离线期变更。
2. **实时监听**：对每个任务 `localDir` 起递归 watcher；任一变更事件 → **防抖**（默认 2s，config `daemonDebounceMs`）合并 → 增量 `sweepJob(该任务)`。
   - 跨平台：darwin/win32 用 `fs.watch(dir, {recursive:true})`；linux 无原生递归 → walk 后逐目录 `fs.watch`，并在收到目录创建/删除事件时动态增删 watcher。
3. **定时兜底**：`setInterval`（默认 30min，config `daemonSweepIntervalMs`）→ 全量 `sweepJob` 所有任务。是**可靠性主干**，补掉漏掉/未监听到的事件。

**并发护栏**：每任务串行——若某任务的 `sweepJob` 正在跑，新触发只置"脏"标记，跑完再补一轮（避免同任务并发 sweep 争抢 journal/锁）。不同任务可顺序处理（本轮不并行任务，简单优先）。

### daemon 生命周期

```
1. 前置校验：已登录（有账号 token）+ 已初始化 vault。解析 MK 一次（resolveMk：优先缓存，否则提示主密码）→ 持于内存至退出。派生 contentKey。建 backend（token 走现有自动刷新）。
2. 载入任务；若空 → 提示「先 bz backup add」并退出（非错误）。
3. 启动即扫（顺序 sweepJob 全部）。
4. 起 watcher（每任务，防抖）+ interval 定时器。进程由 watcher/timer 保活。
5. SIGINT/SIGTERM → 停 watcher、清 timer、等在飞 sweep 跑完 → best-effort 抹除内存 MK → exit 0。
6. 全程向 stderr 打事件（扫描开始/结束、每文件 上传/跳过/失败、定时触发、退出）；绝不打印任何密钥/口令/token。
```

**健壮性**：token 刷新失败/网络错误 → 记录、跳过本轮、等下次触发重试，**不崩溃、不退出**。

### 命令集

- `bz backup add <本地目录> [--to <云端目录>]` — 注册任务（localDir 取绝对路径；校验存在且为目录）。
- `bz backup list` — 列任务：id / localDir / cloudDir / 上次备份时间。
- `bz backup rm <id>` — 删任务（不动云端已备份数据）。
- `bz backup run [<id>]` — 手动跑一次 sweep（给定 id 只跑该任务，否则全部）。需已解锁。
- `bz daemon` — 前台守护（三触发）。需已登录 + 已解锁（或启动时提示主密码）。

## 文件结构

**核心库 `@bizhou/core`（纯 IO/模型，Node 兼容、可测）：**
- 新增 `packages/core/src/backup/index.ts` — `BackupJob` 类型；`readBackups(keyRoot)` / `addBackup(keyRoot, {localDir, cloudDir?})` / `removeBackup(keyRoot, id)` / `updateLastBackup(keyRoot, id, whenISO)`；持久化到 `<keyRoot>/backups.json`（`{version:1, jobs:[]}`，原子 tmp+rename，id 短随机 hex）。纯 IO，不碰网络/加密。

**CLI `bz`：**
- 新增 `packages/cli/src/backup-engine.ts` — `sweepJob(rt, backend, mk, contentKey, job, log)`：walk + 逐文件 `pushOneFile` + 累计 + 单文件错误隔离；返回 `{uploaded, skipped, failed}`。
- 新增 `packages/cli/src/watcher.ts` — `watchRecursive(dir, onChange, {debounceMs})`：返回 `stop()`；含可测的纯 `debounce(fn, ms)` 与递归目录发现（walk）；fs.watch 集成为薄壳。
- 修改 `packages/cli/src/commands.ts` — `cmdBackup`（add/list/rm/run）、`cmdDaemon`（编排 + 优雅退出 + MK 持有 + 并发护栏）。
- 修改 `packages/cli/src/index.ts` — `backup`/`daemon` 命令分发 + HELP + flag（`--to`）。
- 修改 `packages/cli/src/runtime.ts` — 读 config.json 增 `daemonSweepIntervalMs?` / `daemonDebounceMs?`，`Runtime` 暴露（默认 30min / 2s，clamp 合理下限）。

## 测试策略（TDD，先写失败测试）

**备份任务模型（`core/backup`）**
- add→list→rm 往返；id 唯一；`updateLastBackup` 生效；原子写（写坏中断不产半文件——tmp+rename）；`readBackups` 对缺失/损坏返回空/null 安全。

**备份引擎（`backup-engine`，内存后端 + 复用 S1 内存夹具）**
- sweep 一个目录树 → 全部 uploaded；再 sweep → 全部 skipped（dedup）；改动一个文件（内容变）→ 该文件 re-upload、其余 skip；注入一个文件 pushOneFile 抛错 → 该文件计入 failed、其余照常、sweep 不整体失败。

**watcher（`watcher`）**
- 纯 `debounce`：窗口内 N 次调用只触发 1 次、且取最后一次参数；递归目录发现 walk 出全部子目录。（fs.watch 的 OS 事件集成为薄壳，时序依赖，标注为手动/集成验证。）

**daemon 编排（可测单元）**
- 每任务串行护栏：sweep 进行中再触发 → 置脏 → 跑完补一轮（对护栏状态机单测，不起真实进程）。
- 前置校验：无任务时优雅提示退出；未解锁时的提示路径。
- （完整 `bz daemon` 长跑循环 = 手动/集成验证：真机 add 一个目录、起 daemon、改文件、观察增量上云、Ctrl-C 优雅退出。）

## 里程碑拆分（约 5 个 TDD 任务）

- **D1-T1**：`core/backup` 任务模型 + `backups.json` 持久化（add/list/rm/update，原子，测试）。
- **D1-T2**：CLI `bz backup add/list/rm` 命令 + `index.ts` 分发/HELP。
- **D1-T3**：`sweepJob` 引擎（walk + pushOneFile + 累计 + 单文件错误隔离）+ `bz backup run`。
- **D1-T4**：跨平台递归 watcher + 防抖（可测 debounce/walk 单元 + fs.watch 薄壳）。
- **D1-T5**：`bz daemon` 编排（MK 持有、启动即扫、watch+定时双触发、每任务串行护栏、优雅退出）+ config 间隔/防抖。

## 安全红线自检

- daemon 全程**不打印**任何密钥/口令/token；核心 backup 模块只发/返数据、不 print。
- MK 仅驻内存至 daemon 退出（无人值守备份的固有前提）；退出时 best-effort 抹除。
- `backups.json` 只存路径/时间/id，**无密钥**。
- 加密路径完全复用 S1 `pushOneFile`（AES-256-GCM、contentId 仅入加密 encMeta、GCM 失败即抛）；本子项不新增任何加密逻辑。
- 备份语义"永不删云"：daemon 绝不对云端发删除/回收操作。
- 零新增外部运行时依赖（watcher 用 `node:fs.watch`）。
