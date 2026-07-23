# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：v2 云端文件系统层（Phase 2 ✅ 完成；Phase 3/4 进行中）

**最后更新：** 2026-07-23
**当前目标：** 连续完成 v2-Phase 2/3/4（目标驱动）。执行方式：每阶段 写计划 → 子代理驱动（实现+评审）→ 收尾。

### 已完成里程碑（均归档于 `.claude/archive/`）
- **M0 + M1**：真机通过、功能全绿 → `sprint-0-m0-m1.md`
- **v2-Phase 1**：双本地根 + 目录树基础 + 递归 bundle 解析 → `v2-phase1-cloud-fs.md`
- **v2-Phase 2**：上传/下载映射（缺省镜像 + pull 落文件根）+ `push -r`/`pull -r` 整树加密备份还原（105 测试全绿）

### 进行中 / 待办
| 事项 | 责任人 | 状态 |
|------|--------|------|
| v2-Phase 3（mv/cp/rename） | AI | 进行中 |
| v2-Phase 4（回收站，含开放 API 联网验证） | AI | 待启动 |
| git flow 合并 + 发版 | 人工 | 待办（`docs/release/发布准备指南.md`） |

### 代码状态
- 分支 `feature/init_proj`（工作树干净）；`bun test` 105 全绿 + 1 skip；typecheck / lint / build 全过。

### 各模块状态

> 全部稳定，详见 `.claude/module-spec-registry.md`。v2-Phase 1 新增 `config`(双根)/`cloudpath`/`backend`(Local/Baidu) 均已稳定。

### 活跃文件清单

> 当前无进行中的半成品改动。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-23 | v2-Phase 1 全部完成（config 双根/cloudpath/backend/mkdir/ls -r/push --to）+ 递归 bundle 解析（Phase 2 前移）+ 路径穿越修复 | `packages/core/src/{config,cloudpath,backend,baidu}`、`packages/cli/src/{runtime,commands,index}` |
| 2026-07-23 | 统一版本脚本 bump-version.sh + 幂等 publish-buckets.sh + 发布准备指南 | `scripts/`、`.githooks/`、`docs/release/` |
