# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。人工完成后同时更新两处状态。

---

## 当前 Sprint：Sprint 0（项目初始化 + M0 技术验证）

**最后更新：** 2026-07-23
**当前目标：** 完成协作框架初始化；接下来搭 pnpm monorepo 工程骨架并开展 M0 技术验证（OAuth + 上传/下载往返字节一致 + 云端不限制加密大文件）。

### 任务状态

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| — | 协作框架初始化（README/CLAUDE.md/.claude/ 登记表/版本钩子） | 工程 | AI | ✅ 已完成 |
| P0 | 申请/配置百度开放平台应用凭证 + `/apps/bizhou/` 沙盒 | baidu / 外部 | 人工 | ⏳ 待开始 |
| P0 | 初始化 pnpm monorepo（core + cli + tsconfig + Bun/Node 兼容） | 工程 | AI | ⏳ 待开始 |
| P0 | 配置 lint + `bun test` + 类型检查 | 工程 | AI | ⏳ 待开始 |
| P0 | 配置 CI（三平台矩阵，不触真实网盘） | CI/CD | AI | ⏳ 待开始 |
| P0 | M0-Spike：OAuth token → precreate/superfile2/create → 下载字节一致 | baidu | AI | ⏳ 待开始 |
| P0 | M0 关键验证：加密大文件不被云端限制 | baidu / 人工 | 人工 | ⏳ 待开始 |
| P1 | 实测 QPS/配额/限流并记录 | baidu | 人工 | ⏳ 待开始 |

### 模块状态

| 模块 | 状态 | 备注 |
|------|------|------|
| 协作框架（.claude/） | 稳定 | 本次初始化生成 |
| 版本钩子（VERSION/scripts/.githooks） | 稳定 | pre-commit 自动 patch 已激活 |
| packages/core | 待开始 | 骨架未建 |
| packages/cli | 待开始 | 骨架未建 |
| baidu 对接 | 待开始 | 依赖人工提供应用凭证 |

### 活跃文件清单

> 当前无进行中的源码改动。开始 Sprint 0 工程任务后在此登记正在修改的文件，防止冲突。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及模块/文件 |
|------|---------|--------------|
| 2026-07-23 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 全套登记表、版本管理钩子、LICENSE） | 根目录 + `.claude/` + `scripts/` + `.githooks/` |
