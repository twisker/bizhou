# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：v2 云端文件系统层 · Phase 1（双本地根 + 目录树基础）

**最后更新：** 2026-07-23
**当前目标：** 按 `docs/superpowers/plans/2026-07-23-cloud-fs-phase1-roots-and-tree.md` 实现：双本地根（密钥根 `~/.bizhou` + 文件根=下载目录）、`cloudpath` 纯函数、`Backend` 抽象（Local/Baidu）、`bz mkdir` 与 `bz ls`（含 `-r`）。

> **上一 Sprint（Sprint 0 / M0+M1）已完成并归档** → `.claude/archive/sprint-0-m0-m1.md`。M0 真机通过、M1 功能全绿。

### 设计与计划（已就绪）
- 设计：`docs/superpowers/specs/2026-07-23-cloud-filesystem-layer-design.md`（已确认）
- 计划：`docs/superpowers/plans/2026-07-23-cloud-fs-phase1-roots-and-tree.md`（Phase 1）
- Phase 2–4（上传/下载映射含 `-r` 整树备份、mv/cp/rename、回收站）各出独立计划。

### Phase 1 任务状态 —— ✅ 全部完成（subagent-driven）

| 任务 | 所属模块 | 责任人 | 状态 |
|------|----------|--------|------|
| Task 1 双本地根解析（config） | config | AI | ✅ 完成 |
| Task 2 cloudpath 纯函数（含 `..` 拒绝） | cloudpath | AI | ✅ 完成 |
| Task 3 BaiduClient.mkdir + BaiduBundleStore cloudDir | baidu | AI | ✅ 完成 |
| Task 4 Backend 抽象 + LocalBackend | backend | AI | ✅ 完成 |
| Task 5 BaiduBackend + 导出 | backend | AI | ✅ 完成 |
| Task 6 CLI runtime keyRoot/fileRoot + makeBackend | cli/runtime | AI | ✅ 完成 |
| Task 7 `bz mkdir` / `bz ls -r` / `push --to` | cli/commands | AI | ✅ 完成 |
| Task 8 登记表同步 + 阶段收尾 | 文档 | AI | ✅ 完成 |

**验收：** `bun test` 94 全绿 + 1 skip；typecheck 双包通过；biome 无 error；build 3 产物。每任务经实现子代理(TDD)+评审子代理(规格+质量)双关，一处路径穿越 Important 已当场修复。

### 各模块状态

| 模块 | 状态 | 备注 |
|------|------|------|
| config（core） | ✅ 稳定 | 双根（密钥根/文件根） |
| cloudpath（core） | ✅ 稳定 | 纯函数 + 防穿越 |
| backend（core） | ✅ 稳定 | Backend/Local/Baidu |
| baidu（core） | ✅ 稳定 | mkdir + store cloudDir |
| cli runtime/commands | ✅ 稳定 | fileRoot + mkdir/ls/push --to |

### 活跃文件清单

> 当前无进行中的半成品改动。Phase 1 已全部提交，待整分支评审 + 交人工发版。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | Sprint 0（M0+M1）完成并归档；补齐登记表状态 | `.claude/*`、`archive/sprint-0-m0-m1.md` |
| 2026-07-23 | v2 云端 FS 层设计确认 + Phase 1 计划就绪 | `docs/superpowers/{specs,plans}/` |
| 2026-07-23 | 统一版本脚本 bump-version.sh（VERSION+所有 package.json）；pre-commit 调用 | `scripts/`、`.githooks/` |
| 2026-07-23 | v2-Phase 1 全部实现（config 双根/cloudpath/backend/mkdir/ls -r/push --to）+ 路径穿越修复（`..`/`\`） | `packages/core/src/{config,cloudpath,backend,baidu}`、`packages/cli/src/{runtime,commands,index}` |
| 2026-07-23 | 递归 bundle 解析（Phase 2 前移）：子目录资源可按 id/前缀 pull/info/rm/share/preview；补齐最终评审 Important | `packages/cli/src/{commands,runtime}` |
