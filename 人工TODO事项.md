# 人工待办事项

本文件记载需要人工介入的待办事项。与 `.claude/sprint-plan.md` 和 `.claude/current-sprint.md` 双向同步。

---

## 待办事项

> 本表**只保留未完成**的人工任务；完成后移到文末「已完成事项」。

| 编号 | 事项 | 关联 Sprint | 优先级 | 状态 |
|------|------|------------|--------|------|
| H-05 | 准备发布渠道并发版（详见 `docs/release/发布准备指南.md`）：npm（已有组织 `twisker`，需定 scope）、GitHub Homebrew tap 仓库、Scoop bucket 仓库、GitHub Release。 | 发布 | P2 | 待开始 |
| H-07 | `git push` 由人工手动触发（AI 不自动推送）。 | 全程 | P0 | 长期有效 |

---

## 已完成事项

| 编号 | 事项 | 完成日期 | 备注 |
|------|------|---------|------|
| H-00 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 登记表、版本钩子、LICENSE） | 2026-07-23 | 由 project-bootstrap 生成 |
| H-01 | 获取百度开放平台应用凭证并存入本地 `.env`（BAIDU_APP_ID/APP_KEY/SECRET_KEY/SIGN_KEY） | 2026-07-23 | 凭证不入库；`.env.example` 为可提交模板 |
| H-02 | M0 关键验证：真机 `scripts/m0-verify.sh 500`，500MB 加密文件上传→下载字节级一致、云端未限制/封禁 | 2026-07-23 | 全案前提成立 |
| H-03 | 实测 QPS/配额/限流：上行 ≈5.5MB/s、下行 ≈1.1MB/s，无限流触发 | 2026-07-23 | 记入 tech-spec §5；如需更精确上限可后续并发压测 |
