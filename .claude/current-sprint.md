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

### Phase 1 任务状态

| 任务 | 所属模块 | 责任人 | 状态 |
|------|----------|--------|------|
| Task 1 双本地根解析（config） | config | AI | ⏳ 待开始 |
| Task 2 cloudpath 纯函数 | cloudpath | AI | ⏳ 待开始 |
| Task 3 BaiduClient.mkdir + BaiduBundleStore cloudDir | baidu | AI | ⏳ 待开始 |
| Task 4 Backend 抽象 + LocalBackend | backend | AI | ⏳ 待开始 |
| Task 5 BaiduBackend + 导出 | backend | AI | ⏳ 待开始 |
| Task 6 CLI runtime keyRoot/fileRoot + makeBackend | cli/runtime | AI | ⏳ 待开始 |
| Task 7 `bz mkdir` / `bz ls -r` / `push --to` | cli/commands | AI | ⏳ 待开始 |
| Task 8 登记表同步 + 阶段收尾 | 文档 | AI | ⏳ 待开始 |

### 各模块状态（本 Sprint 相关）

| 模块 | 状态 | 备注 |
|------|------|------|
| config（core） | 待改 | 加双根解析 |
| cloudpath（core） | 待建 | 新模块 |
| backend（core） | 待建 | 新模块（Local/Baidu） |
| baidu（core） | 待改 | 加 mkdir + store cloudDir |
| cli runtime/commands | 待改 | fileRoot + mkdir/ls |

### 活跃文件清单

> 当前无进行中的半成品改动（计划文档已提交，尚未开始 Phase 1 编码）。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | Sprint 0（M0+M1）完成并归档；补齐登记表状态（含 chunker/发版的诚实修正） | `.claude/*`、`archive/sprint-0-m0-m1.md` |
| 2026-07-23 | v2 云端 FS 层设计确认 + Phase 1 实现计划就绪 | `docs/superpowers/{specs,plans}/` |
