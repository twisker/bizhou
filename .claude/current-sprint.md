# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前状态：Sprint 间歇（v2-Phase 1 已完成并归档；v2-Phase 2 待启动）

**最后更新：** 2026-07-23

### 已完成里程碑
- **M0 + M1**（客户端加密引擎 + CLI）：真机通过、功能全绿 → 归档 `.claude/archive/sprint-0-m0-m1.md`
- **v2-Phase 1**（云端 FS 层：双本地根 + 目录树基础 + 递归 bundle 解析）：opus 整分支评审 ✅ Ready to merge → 归档 `.claude/archive/v2-phase1-cloud-fs.md`

### 代码状态
- 分支 `feature/init_proj`（工作树干净，领先 `dev`/`main` 各约 49 提交），由人工按 git flow 合并/发版。
- `bun test` 96 全绿 + 1 skip；typecheck / lint / build（3 产物）全过。

### 下一步（待人工触发）
| 事项 | 责任人 | 状态 |
|------|--------|------|
| git flow 合并 `feature/init_proj → dev`、发版（`dev→main` tag + npm/tap/bucket） | 人工 | 待办（见 `docs/release/发布准备指南.md`） |
| 启动 **v2-Phase 2**（`push -r`/`pull -r` 整树备份还原、`pull` 落文件根映射、重名歧义） | AI（需人工示意开工） | 待启动（brainstorm → 计划 → 子代理执行） |
| 后续 v2-Phase 3（mv/cp/rename）、v2-Phase 4（回收站） | AI | 待启动 |

### 各模块状态

> 全部稳定，详见 `.claude/module-spec-registry.md`。v2-Phase 1 新增 `config`(双根)/`cloudpath`/`backend`(Local/Baidu) 均已稳定。

### 活跃文件清单

> 当前无进行中的半成品改动。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | v2-Phase 1 全部完成（config 双根/cloudpath/backend/mkdir/ls -r/push --to）+ 递归 bundle 解析（Phase 2 前移）+ 路径穿越修复 | `packages/core/src/{config,cloudpath,backend,baidu}`、`packages/cli/src/{runtime,commands,index}` |
| 2026-07-23 | 统一版本脚本 bump-version.sh + 幂等 publish-buckets.sh + 发布准备指南 | `scripts/`、`.githooks/`、`docs/release/` |
