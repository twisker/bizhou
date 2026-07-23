# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：Phase 3 · S1 + S2 + D1 ✅ 完成（2026-07-24，待人工 git flow 合并）

**最后更新：** 2026-07-24

- **设计：** `docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`（S1+S2）、`docs/superpowers/specs/2026-07-24-daemon-scheduled-backup-design.md`（D1）
- **计划：** `docs/superpowers/plans/2026-07-23-robust-upload-s1.md`、`docs/superpowers/plans/2026-07-23-robust-download-s2.md`、`docs/superpowers/plans/2026-07-24-daemon-scheduled-backup-d1.md`
- **登记：** `.claude/sprint-plan.md` → Phase 3 · S1 / S2 / D1
- **执行方式：** 子代理驱动开发（每任务 实现 + 评审），整分支评审后交人工按 git flow 合并。

### 任务状态
| 任务 | 说明 | 状态 |
|-----|------|------|
| S1-T1..T6 | 健壮上传（contentId 底座 / 并发池 / 上传日志 / manifest 缓存 / cmdPush 集成 / push -r） | ✅ 全部完成 |
| S2-T1 | decryptChunksToFile 支持 skip 续传（定位写入）+ journal 上传专属字段改可选 | ✅ 已完成 |
| S2-T2 | cmdPull 集成：幂等/在飞锁/分片续传/**端到端 contentId 校验**/原子落地/--force（抽 pullOneBundle） | ✅ 已完成 |
| S2-T3 | pull -r 递归复用 pullOneBundle | ✅ 已完成 |
| D1-T1 | 备份任务模型 + `backups.json` 持久化（add/list/rm/update，原子，无密钥） | ✅ 已完成 |
| D1-T2 | CLI `bz backup add/list/rm`（`daemon.ts`，单向依赖 commands.ts） | ✅ 已完成 |
| D1-T3 | `sweepJob` 幂等备份引擎 + `bz backup run` | ✅ 已完成 |
| D1-T4 | 跨平台递归 watcher + 防抖（`watcher.ts`） | ✅ 已完成 |
| D1-T5 | `bz daemon` 三触发编排 + `SerialJobRunner` 串行护栏 + 优雅退出 + config 间隔/防抖 | ✅ 已完成 |

### 已完成里程碑（均归档于 `.claude/archive/`）
- **M0 + M1**（加密引擎 + CLI）→ `sprint-0-m0-m1.md`
- **v2 Phase 1–4 整体**（目录树 / 映射 / 整树备份 / mv-cp-rename / 回收站）→ `v2-cloud-fs.md`

### 代码状态
- 分支 `feature/phase3`；`bun test` **180 全绿 + 1 skip**；typecheck/lint/build(3) 全过。
- S1（健壮上传）+ S2（健壮下载）+ D1（daemon/定时备份）全部完成。S1/S2 两轮 opus 整分支评审均 ✅ Ready to merge，拦下并修复 2 Critical crypto（resume DEK / 确定性IV nonce 复用）+ 2 Important（S1）；S2 无新 Critical/Important。D1 各任务子代理驱动 + 逐任务评审（T1 拦下备份任务读失败吞错/tmp 文件名冲突 2 Important；T3 拦下 resolve(localDir) 与 cmdPushRecursive 未对齐；T4 拦下 stop() 竞态漏 FSWatcher）。
- v2 已由人工合并至 `dev`；本分支由人工按 git flow 管理。

### 待人工触发（并行）
| 事项 | 责任人 | 状态 |
|------|--------|------|
| 发版（`dev→main` tag + npm/tap/bucket，见 `docs/release/发布准备指南.md`） | 人工 | 待办 |
| H-08 百度回收站管理接口联网验证 | 人工 | 待验证 |
| `bz daemon` 真机集成验证（backup add → daemon → 改/加文件 → 观察增量上云/跳过 → Ctrl-C 优雅退出） | 人工 | 待验证 |

### 新增模块/能力（Phase 3 落地）
- `@bizhou/core` → `content/`（内容身份 contentId）、`journal/`（上传/下载日志：在飞锁+续传状态）、`cache/`（manifest 缓存）、`backup/`（备份任务模型 + `backups.json`）；`decryptChunksToFile` 支持 `skip` 续传；IV 方案改确定性（tech-spec §5.1.1）。
- CLI → `pushOneFile`/`pullOneBundle` 两个共用内核（单文件与 `-r` 递归共用）；`push`/`pull` 增 `--force`，`push` 增 `--concurrency`；`daemon.ts`（`cmdBackup`/`sweepJob`/`SerialJobRunner`/`cmdDaemon`）+ `watcher.ts`（`watchRecursive`/`debounce`）：`bz backup add/list/rm/run` + `bz daemon`（启动即扫 + 实时监听防抖 + 定时兜底，SIGINT/SIGTERM 优雅退出，MK 驻内存至退出并 best-effort 抹除）。

### 活跃文件清单

> 开工前工作树干净。Phase 3 改动集中于 `packages/core/src/{content,journal,cache,chunker,resource,crypto,bundle,baidu,backup}`、`packages/cli/src/{commands,runtime,index,daemon,watcher}.ts` 及对应测试 + `test/helpers/memory-fixture.ts`。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | v2 云端 FS 层 Phase 1–4 全部完成（目录树/映射/整树备份/mv-cp-rename/回收站）；多处路径穿越与分派安全修复 | `packages/core/src/{config,cloudpath,backend,baidu,resource}`、`packages/cli/src/{runtime,commands,index}` |
| 2026-07-23 | S1-T5：`cmdPush` 单文件路径接入内容去重（走 manifest 缓存）+ 在飞锁/续传（journal）+ `--force`/`--concurrency`；抽出共用 `pushOneFile`/`resolveUploadConcurrency`/`findDuplicateBundle`；修复 `onProgress`（同步、不 await）与 `appendDoneChunk`（非原子读改写）之间的竞态——用串行链式 Promise 队列保证"分片写完即落盘日志"，`packResource` 后/失败时均 `await` 该队列再决定 removeJournal 或保留续传；新增内存后端测试夹具 `test/helpers/memory-fixture.ts` | `packages/cli/src/{commands,runtime,index}.ts`、`packages/cli/test/{push-idempotency.test.ts,helpers/memory-fixture.ts}` |
| 2026-07-24 | D1-T1..T5：备份任务模型 + `backups.json`（core）→ `bz backup add/list/rm/run`（`daemon.ts`）→ `sweepJob` 幂等引擎（复用 `pushOneFile`）→ `watchRecursive` 跨平台递归监听 + 防抖（`watcher.ts`）→ `bz daemon` 三触发编排（启动即扫/watch/定时）+ `SerialJobRunner` 每任务串行护栏（运行中多次触发合并为一次补跑）+ SIGINT/SIGTERM 优雅退出（停 watcher/清定时器/等在飞 sweep drain 完）+ MK best-effort 抹除；`runtime.ts` 新增 `daemonSweepIntervalMs`(默认 30min,min 5s)/`daemonDebounceMs`(默认 2s,min 100ms) config 字段 | `packages/core/src/backup/`、`packages/cli/src/{daemon,watcher,runtime,index}.ts`、`packages/cli/test/{backup-cmd,sweep,watcher,serial-runner}.test.ts` |
