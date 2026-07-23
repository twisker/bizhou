# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前状态：Sprint 间歇（v2 云端文件系统层全部完成并归档）

**最后更新：** 2026-07-23

### 已完成里程碑（均归档于 `.claude/archive/`）
- **M0 + M1**（加密引擎 + CLI）：真机通过、功能全绿 → `sprint-0-m0-m1.md`
- **v2-Phase 1**（双本地根 + 目录树基础 + 递归解析）→ `v2-phase1-cloud-fs.md`
- **v2 Phase 1–4 整体**（目录树 / 映射 / 整树备份 / mv-cp-rename / 回收站）→ `v2-cloud-fs.md`

### 代码状态
- 分支 `feature/init_proj`（工作树干净）；`bun test` **131 全绿 + 1 skip**；typecheck / lint / build（3 产物）全过。
- 由人工按 git flow 合并（`feature/init_proj → dev`）与发版。

### 下一步（待人工触发）
| 事项 | 责任人 | 状态 |
|------|--------|------|
| git flow 合并 + 发版（`dev→main` tag + npm/tap/bucket，见 `docs/release/发布准备指南.md`） | 人工 | 待办 |
| H-08 百度回收站管理接口联网验证 | 人工 | 待验证 |
| Phase 3 打磨（shell 补全、更多预览、daemon/定时备份、worker_threads 并行、进 homebrew-core/winget） | AI（需人工示意） | 远期待细化 |

### 各模块状态

> 全部稳定，详见 `.claude/module-spec-registry.md`。v2 新增 config(双根)/cloudpath/backend(含 move/copy/rename/回收站) 均稳定。

### 活跃文件清单

> 当前无进行中的半成品改动。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | v2 云端 FS 层 Phase 1–4 全部完成（目录树/映射/整树备份/mv-cp-rename/回收站）；多处路径穿越与分派安全修复 | `packages/core/src/{config,cloudpath,backend,baidu,resource}`、`packages/cli/src/{runtime,commands,index}` |
