# 人工待办事项

本文件记载需要人工介入的待办事项。与 `.claude/sprint-plan.md` 和 `.claude/current-sprint.md` 双向同步。

---

## 待办事项

| 编号 | 事项 | 关联 Sprint | 优先级 | 状态 |
|------|------|------------|--------|------|
| H-01 | 申请百度网盘**开放平台应用凭证**（AppKey/SecretKey）。凭证已获取并存入本地 `.env`（AppID/AppKey/SecretKey/SignKey）。沙盒 `/apps/bizhou/` 可操作性并入 M0 spike 验证（见 H-02）。 | Sprint 0 (M0) | P0 | ✅ 已完成 |
| H-02 | 完成 M0 **关键验证**（全案前提）。已封装成一条命令，你只需先 `bun packages/cli/src/index.ts login` 授权，然后：<br>`export BIZHOU_MASTER_PASSWORD=<主密码> && scripts/m0-verify.sh 500`<br>脚本自动跑「生成大文件→加密上传→下载还原→SHA-256 字节级校验→输出耗时/吞吐」，最后请你人工确认账号未被限制/封禁，并把 QPS/配额记入 tech-spec §5。**对接代码已实现并通过 mock 测试 + >4GB 本地分片还原已证，只差真实 OAuth + 联网。** | Sprint 0 (M0) | P0 | 待开始 |
| H-03 | 实测并记录百度接口 **QPS / 配额 / 频率限制**，供 AI 设定并发与退避策略。 | Sprint 0 (M0) | P1 | 待开始 |
| H-05 | 准备发布渠道账号：npm 组织 `@bizhou`、GitHub Homebrew tap 仓库、Scoop bucket 仓库。 | Sprint 4 | P2 | 待开始 |
| H-07 | `git push` 由人工手动触发（AI 不自动推送）。 | 全程 | P0 | 进行中 |

---

## 已完成事项

| 编号 | 事项 | 完成日期 | 备注 |
|------|------|---------|------|
| H-00 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 登记表、版本钩子、LICENSE） | 2026-07-23 | 由 project-bootstrap 生成 |
| H-01 | 获取百度开放平台应用凭证并存入本地 `.env`（BAIDU_APP_ID/APP_KEY/SECRET_KEY/SIGN_KEY） | 2026-07-23 | 凭证不入库；`.env.example` 为可提交模板 |
