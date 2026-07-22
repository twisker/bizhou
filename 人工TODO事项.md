# 人工待办事项

本文件记载需要人工介入的待办事项。与 `.claude/sprint-plan.md` 和 `.claude/current-sprint.md` 双向同步。

---

## 待办事项

| 编号 | 事项 | 关联 Sprint | 优先级 | 状态 |
|------|------|------------|--------|------|
| H-01 | 申请百度网盘**开放平台应用凭证**（AppKey/SecretKey），确认可操作 `/apps/bizhou/` 沙盒目录。个人应用创建可能受限，需提前确认。 | Sprint 0 (M0) | P0 | 待开始 |
| H-02 | 用一个测试百度账号完成 M0 **关键验证**：上传"内容不可识别的加密大文件"，确认云端不因此限制/封禁（全案前提）。 | Sprint 0 (M0) | P0 | 待开始 |
| H-03 | 实测并记录百度接口 **QPS / 配额 / 频率限制**，供 AI 设定并发与退避策略。 | Sprint 0 (M0) | P1 | 待开始 |
| H-04 | 确认加密/密钥架构关键决策（KDF 选 scrypt 还是 argon2id、默认参数、恢复密钥形态）——涉及安全，需人工拍板。 | Sprint 1 | P1 | 待开始 |
| H-05 | 准备发布渠道账号：npm 组织 `@bizhou`、GitHub Homebrew tap 仓库、Scoop bucket 仓库。 | Sprint 4 | P2 | 待开始 |
| H-06 | 每个 Sprint 开始前，确认是否启动该 Sprint（AI 需收到明确答复后才开发）。 | 全程 | P0 | 进行中 |
| H-07 | `git push` 由人工手动触发（AI 不自动推送）。 | 全程 | P0 | 进行中 |

---

## 已完成事项

| 编号 | 事项 | 完成日期 | 备注 |
|------|------|---------|------|
| H-00 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 登记表、版本钩子、LICENSE） | 2026-07-23 | 由 project-bootstrap 生成 |
