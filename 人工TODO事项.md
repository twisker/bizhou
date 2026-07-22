# 人工待办事项

本文件记载需要人工介入的待办事项。与 `.claude/sprint-plan.md` 和 `.claude/current-sprint.md` 双向同步。

---

## 待办事项

| 编号 | 事项 | 关联 Sprint | 优先级 | 状态 |
|------|------|------------|--------|------|
| H-01 | 申请百度网盘**开放平台应用凭证**（AppKey/SecretKey）。凭证已获取并存入本地 `.env`（AppID/AppKey/SecretKey/SignKey）。沙盒 `/apps/bizhou/` 可操作性并入 M0 spike 验证（见 H-02）。 | Sprint 0 (M0) | P0 | ✅ 已完成 |
| H-02 | 用一个测试百度账号完成 M0 **关键验证**：上传"内容不可识别的加密大文件"，确认云端不因此限制/封禁（全案前提）。 | Sprint 0 (M0) | P0 | 待开始 |
| H-03 | 实测并记录百度接口 **QPS / 配额 / 频率限制**，供 AI 设定并发与退避策略。 | Sprint 0 (M0) | P1 | 待开始 |
| H-04 | 确认加密/密钥架构关键决策（KDF 选 scrypt 还是 argon2id、默认参数、恢复密钥形态）——涉及安全，需人工拍板。 | Sprint 1 | P1 | 待开始 |
| H-05 | 准备发布渠道账号：npm 组织 `@bizhou`、GitHub Homebrew tap 仓库、Scoop bucket 仓库。 | Sprint 4 | P2 | 待开始 |
| H-07 | `git push` 由人工手动触发（AI 不自动推送）。 | 全程 | P0 | 进行中 |

---

## 已完成事项

| 编号 | 事项 | 完成日期 | 备注 |
|------|------|---------|------|
| H-00 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 登记表、版本钩子、LICENSE） | 2026-07-23 | 由 project-bootstrap 生成 |
| H-01 | 获取百度开放平台应用凭证并存入本地 `.env`（BAIDU_APP_ID/APP_KEY/SECRET_KEY/SIGN_KEY） | 2026-07-23 | 凭证不入库；`.env.example` 为可提交模板 |
