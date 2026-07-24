# 云端文件系统层 · Phase 4（回收站）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** `bz rm <路径|id> [-r] [--yes]` 删除到回收站；`bz trash [list|restore <x>|rm <x>|clear]` 管理回收站。

**Architecture:** `Backend` 增回收站方法。**BaiduBackend**：删除走原生 filemanager delete（进百度原生回收站）；回收站**管理**（list/restore/clear/rm）百度开放平台未提供接口 → 抛清晰错误提示去百度 App（用户已接受此兜底，不自建云端 .trash）。**LocalBackend**（离线/自建后端）：用 `<baseDir>/.trash/` 实现完整回收站（可测）。核心库只发事件、无 Bun 专有 API。

**Tech Stack:** TS + Bun · `bun test` · `node:fs/promises`。

## Global Constraints
- `@bizhou/core` 只用 `node:` builtins、无 Bun 专有 API、只发事件、绝不 print、密钥绝不打印/入库。
- 云端根固定 `/apps/bizhou/`；路径经 cloudpath（拒 `..`/`\`）。
- 每任务：`bun test` 全绿 + typecheck 干净 + biome 无 error；pre-commit 自动 bump；不 push。
- 已存在：`resolveBundleOrNull`、`makeBackend`、`Backend.{mkdir,listDir,bundleStore,move,copy,rename,remove?}`、`BaiduBundleStore.remove`（filemanager delete→回收站）、`BaiduClient.deletePaths`、`bundleDirName`、`normalizeCloudPath`/`joinCloudPath`/`cloudBasename`、`assertNameSegment`。

---
## 文件结构
| 文件 | 责任 |
|---|---|
| `packages/core/src/backend/index.ts`（改） | `Backend` 加回收站方法 + `TrashEntry` 类型 |
| `packages/core/src/backend/local.ts`（改） | `.trash/` 实现（trashPath/listTrash/restoreTrash/clearTrash/deleteTrash） |
| `packages/core/src/backend/baidu.ts`（改） | trashPath=原生 delete；管理方法抛"去 App"提示 |
| `packages/cli/src/commands.ts`、`index.ts`（改） | `cmdRm`(扩展 -r/--yes/目录) + `cmdTrash` + 分发 + HELP |
| 各 test | 测试 |

---
## Task 1: Backend 回收站（Local `.trash` + Baidu 原生/提示）

**Interfaces produced（加到 `Backend`）：**
- `trashPath(cloudPath: string): Promise<void>` — 把目录或 `<id>.bz` 删到回收站。
- `listTrash(): Promise<TrashEntry[]>`；`restoreTrash(entryId: string): Promise<void>`；`deleteTrash(entryId: string): Promise<void>`；`clearTrash(): Promise<void>`。
- `interface TrashEntry { entryId: string; name: string; originalPath: string; deletedAt: string }`

**LocalBackend 实现（`<baseDir>/.trash/`）：** trashPath 把 `abs(cloudPath)` 移到 `<baseDir>/.trash/<entryId>/`（entryId 用调用方注入的时间戳+随机；为保持纯净由 backend 生成 `randomBytes` hex 即可），并写 `<entryId>.json`（记 originalPath=cloudPath、name=cloudBasename、deletedAt 由调用方注入或 backend 用 `new Date().toISOString()`——**注意核心库不读时钟**：给 `trashPath(cloudPath, deletedAt)` 加参数由 CLI 注入时间戳）。listTrash 读 `.trash/*.json`；restoreTrash 移回 originalPath（父目录 mkdir）；deleteTrash 删该项；clearTrash 清空 `.trash/`。`listDir` 须忽略 `.trash` 目录（不列为普通子目录）。

**BaiduBackend 实现：** `trashPath(cloudPath)` = `client.deletePaths([remote(cloudPath)])`（进原生回收站）。`listTrash/restoreTrash/deleteTrash/clearTrash` → `throw new BizhouError("BAIDU", "百度开放平台未提供回收站管理接口，请到百度网盘 App/网页的回收站操作")`。

> 时钟注入：`trashPath(cloudPath: string, deletedAt: string)`；LocalBackend 用它写 meta，BaiduBackend 忽略。entryId 由 backend 内部 `randomBytes(8).toString("hex")` 生成（非时钟）。

- [ ] Step 1 失败测试：
  - `backend.local.test.ts`：mkdir `/a` + 建 bundle；`trashPath("/a","2026-07-23T00:00:00Z")` → `/a` 不在 listDir、`listTrash` 有一条 originalPath="/a"；`restoreTrash(entryId)` → `/a` 回来；再 trash + `deleteTrash`/`clearTrash` 清空；`listDir("/")` 不含 `.trash`。
  - `backend.baidu.test.ts`：`trashPath` 触发 filemanager delete（mock 断言 opera=delete）；`listTrash()` rejects（"请到百度网盘 App"）。
- [ ] Step 2–5：RED→实现→GREEN（`bun test packages/core/`）→ typecheck+biome→提交 `feat(core): Backend 回收站（Local .trash + Baidu 原生删除/管理提示）`。

---
## Task 2: CLI `rm`（扩展）+ `trash`

**Design：**
- `cmdRm(rt, src, opts{recursive, yes})`：`b = resolveBundleOrNull(rt, src, local)`；`isBundle=b!==null`；`path = b ? joinCloudPath(b.dir, bundleDirName(b.id)) : normalizeCloudPath(src)`。若是目录（!isBundle）且 `!yes` → 提示"删除目录 <path> 及其内容将进回收站，请加 --yes 确认"并抛 INVALID_ARG（`-r` 亦要求 yes 语义可合并：目录删除一律需 --yes）。执行 `backend.trashPath(path, new Date().toISOString())`；ok。
- `cmdTrash(rt, sub, arg, opts)`：`list`→`backend.listTrash()` 逐条打印 `entryId  name  originalPath  deletedAt`；`restore <entryId>`→`restoreTrash`；`rm <entryId>`→`deleteTrash`；`clear`→`clearTrash`。（Baidu 后端这些会抛"去 App"提示，属预期。）
- `index.ts`：`rm` 传 `recursive/yes`（加 `--yes` 布尔 option）；新增 `trash [list|restore <id>|rm <id>|clear]` case；HELP 更新。

- [ ] Step 1 失败测试（fs.test.ts，本地后端）：push bundle 到 `/t`；`cmdRm(rt,<id>,{local})`→`ls /t` 不含、`cmdTrash(rt,"list",...)` 含该名；`cmdTrash(rt,"restore",<entryId>)`→恢复后 `ls /t` 又含；`cmdMkdir /dd`+push，`cmdRm(rt,"/dd",{local})` 无 --yes 抛错，加 `{yes:true}` 成功进回收站；`cmdTrash(rt,"clear")` 清空后 list 为空。
- [ ] Step 2–5：RED→实现→GREEN（全量 `bun test`）→ typecheck+biome→提交 `feat(cli): bz rm 进回收站(-r/--yes) + bz trash 管理`。

---
## Task 3: 登记表同步 + Phase 4 收尾 + v2 整体归档
- [ ] 更新 `.claude/{module-spec,test-registry,current-sprint,sprint-plan}.md`：Phase 4 完成、命令表加 trash、计数；标注**百度回收站管理接口需联网验证**（tech-spec §5 或人工TODO）。
- [ ] 全量验收（test/typecheck/biome/build）。
- [ ] 归档 v2（current-sprint→`.claude/archive/v2-cloud-fs.md`），current-sprint 重置。
- [ ] 提交 `docs: v2-Phase 4 收尾 + v2 云端 FS 层整体完成归档`。

---
## Self-Review（对照 spec §8/§13）
- §8 rm→原生回收站（本地 .trash）、trash 管理（Baidu 提示 / Local 实现）、开放 API 不支持则提示 → T1/T2。§13 Phase 4 覆盖。
- 类型一致：`Backend.{trashPath,listTrash,restoreTrash,deleteTrash,clearTrash}`、`TrashEntry`、`cmdRm(rt,src,{recursive,yes})`、`cmdTrash(rt,sub,arg,opts)`。
- 安全：路径经 normalizeCloudPath；restore 目标经 originalPath（本地已 normalize 存入）；不打印密钥。已知风险：**百度回收站管理接口未验证**，当前以"去 App"兜底。
