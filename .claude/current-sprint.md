# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：Phase 3 · S1 — 健壮上传（并发 + 续传 + 幂等）

**最后更新：** 2026-07-23

- **设计：** `docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`
- **计划：** `docs/superpowers/plans/2026-07-23-robust-upload-s1.md`（各任务完整 TDD 步骤）
- **登记：** `.claude/sprint-plan.md` → Phase 3 · S1
- **执行方式：** 子代理驱动开发（每任务 实现 + 评审），整分支评审后交人工按 git flow 合并。

### 任务状态
| 任务 | 说明 | 状态 |
|-----|------|------|
| S1-T1 | contentId 底座（HKDF+HMAC，存加密 encMeta） | ⬜ 待开始 |
| S1-T2 | uploadPart 限流池并发 + fail-fast | ⬜ 待开始 |
| S1-T3 | 上传日志（锁 + 续传状态） | ⬜ 待开始 |
| S1-T4 | manifest 缓存 + 失效钩子 | ⬜ 待开始 |
| S1-T5 | cmdPush 集成（去重/锁/续传/--force/--concurrency） | ✅ 已完成（2026-07-23） |
| S1-T6 | push -r 递归复用 pushOneFile | ⬜ 待开始 |

### 已完成里程碑（均归档于 `.claude/archive/`）
- **M0 + M1**（加密引擎 + CLI）→ `sprint-0-m0-m1.md`
- **v2 Phase 1–4 整体**（目录树 / 映射 / 整树备份 / mv-cp-rename / 回收站）→ `v2-cloud-fs.md`

### 代码状态
- 分支 `feature/init_proj`；`bun test` 147 全绿 + 1 skip（S1-T5 完成后，含新增 push-idempotency 4 测试）。
- v2 已由人工合并至 `dev`；S1 开发分支由人工按 git flow 管理。

### 待人工触发（并行）
| 事项 | 责任人 | 状态 |
|------|--------|------|
| 发版（`dev→main` tag + npm/tap/bucket，见 `docs/release/发布准备指南.md`） | 人工 | 待办 |
| H-08 百度回收站管理接口联网验证 | 人工 | 待验证 |

### 新增模块（S1 落地后登记到 module-spec-registry）
- `@bizhou/core` → `content/`（内容身份）、`journal/`（上传日志：锁+续传）、`cache/`（manifest 缓存）。

### 活跃文件清单

> S1 将新建 `packages/core/src/{content,journal,cache}/index.ts` 及对应测试；改 `baidu/client.ts`、`bundle`/`resource`/`index.ts`、`cli/{commands,runtime,index}.ts`。开工前工作树干净。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | v2 云端 FS 层 Phase 1–4 全部完成（目录树/映射/整树备份/mv-cp-rename/回收站）；多处路径穿越与分派安全修复 | `packages/core/src/{config,cloudpath,backend,baidu,resource}`、`packages/cli/src/{runtime,commands,index}` |
| 2026-07-23 | S1-T5：`cmdPush` 单文件路径接入内容去重（走 manifest 缓存）+ 在飞锁/续传（journal）+ `--force`/`--concurrency`；抽出共用 `pushOneFile`/`resolveUploadConcurrency`/`findDuplicateBundle`；修复 `onProgress`（同步、不 await）与 `appendDoneChunk`（非原子读改写）之间的竞态——用串行链式 Promise 队列保证"分片写完即落盘日志"，`packResource` 后/失败时均 `await` 该队列再决定 removeJournal 或保留续传；新增内存后端测试夹具 `test/helpers/memory-fixture.ts` | `packages/cli/src/{commands,runtime,index}.ts`、`packages/cli/test/{push-idempotency.test.ts,helpers/memory-fixture.ts}` |
