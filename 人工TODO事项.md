# 人工待办事项

本文件记载需要人工介入的待办事项。与 `.claude/sprint-plan.md` 和 `.claude/current-sprint.md` 双向同步。

---

## 待办事项

> 本表**只保留未完成**的人工任务；完成后移到文末「已完成事项」。

| 编号 | 事项 | 关联 Sprint | 优先级 | 状态 |
|------|------|------------|--------|------|
| H-07 | `git push` 由人工手动触发（AI 不自动推送；发布等经明确授权的操作除外）。 | 全程 | P0 | 长期有效 |
| H-08 | 联网验证百度**回收站管理接口**是否在开放平台可用（list/restore/clear）。当前 `bz trash *` 对百度后端抛"请到百度网盘 App 操作"兜底；删除进原生回收站已可用。若开放 API 支持，可后续接入 BaiduBackend。 | v2-P4 | P2 | 待验证 |
| H-09 | `bz daemon` 真机集成验证：`bz backup add <目录>` → `bz daemon` → 改/新增文件 → 观察 stderr 增量上云、未变文件跳过 → Ctrl-C 观察优雅退出（等在飞 sweep 完成再退出，无残留进程）。自动化仅覆盖 `SerialJobRunner`/`sweepJob`/`watchRecursive` 纯逻辑，完整长跑循环 + 信号处理未自动化。 | Phase 3 · D1 | P1 | 待验证 |
| H-10 | `bz completion powershell` 真机 pwsh 验证：本机（CI/开发环境）无 `pwsh` 二进制，`genPowerShell` 的 flag/文件目录（`CompleteFilename`）/子命令前缀（`-like`）补全逻辑只有字符串/结构断言，未跑过真实 tab 补全。需在装有 PowerShell 7+ 的环境里 `bz completion powershell | Out-String | Invoke-Expression` 后手动敲 `bz push <TAB>`、`bz backup add <TAB>`、`bz account u<TAB>`、`bz push --com<TAB>` 等场景验证候选正确。 | Phase 3 · C1 | P2 | 待验证 |

---

## 已完成事项

| 编号 | 事项 | 完成日期 | 备注 |
|------|------|---------|------|
| H-00 | 初始化 AI-Human 协作框架（README、CLAUDE.md、.claude/ 登记表、版本钩子、LICENSE） | 2026-07-23 | 由 project-bootstrap 生成 |
| H-01 | 获取百度开放平台应用凭证并存入本地 `.env`（BAIDU_APP_ID/APP_KEY/SECRET_KEY/SIGN_KEY） | 2026-07-23 | 凭证不入库；`.env.example` 为可提交模板 |
| H-02 | M0 关键验证：真机 `scripts/m0-verify.sh 500`，500MB 加密文件上传→下载字节级一致、云端未限制/封禁 | 2026-07-23 | 全案前提成立 |
| H-03 | 实测 QPS/配额/限流：上行 ≈5.5MB/s、下行 ≈1.1MB/s，无限流触发 | 2026-07-23 | 记入 tech-spec §5；如需更精确上限可后续并发压测 |
| H-05 | 准备发布渠道：npm `bizhou` 组织（scope 方案 A）、gh 登录 twisker、remote twisker/bizhou | 2026-07-23 | tap/bucket 由 `scripts/publish-buckets.sh` 幂等自动创建 |
