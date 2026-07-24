# 归档：v2 云端文件系统层（Phase 1–4 全部完成）

**完成日期：** 2026-07-23
**设计：** `docs/superpowers/specs/2026-07-23-cloud-filesystem-layer-design.md`
**执行：** subagent-driven（每任务 实现子代理 TDD + 评审子代理 规格/质量双关；Critical/Important 当场修复）

## 交付
- **Phase 1** 双本地根（密钥根 `~/.bizhou` + 文件根=下载目录）+ 真实目录树（`Backend`/Local/Baidu、`cloudpath`、`bz mkdir`/`ls -r`）+ 递归 bundle 解析。
- **Phase 2** 上传/下载映射（`push` 缺省镜像、`pull` 落文件根带入结构）+ `push -r`/`pull -r` 整树加密备份/还原。
- **Phase 3** `mv` / `cp`(`-r`) / `rename`（目录 native；bundle 真名=重写 encMeta）。
- **Phase 4** `rm`→回收站（目录需 `--yes`）+ `bz trash [list/restore/rm/clear]`（Local `.trash` 完整；Baidu 原生删除 + 管理提示去 App）。

## 质量
- `bun test` 131 全绿 + 1 skip；typecheck / lint / build（3 产物）全过。
- opus 整分支最终评审（Phase 1）Ready to merge。
- 评审发现并修复的安全项：路径穿越 `..`、Windows `\..\`、`downloadLocalPath`/`pull --out` 的 `meta.name` 穿越、`rename` newName 穿越、mv/cp/rename 分派吞错（歧义/后端错误）。

## 遗留（人工）
- **H-08**：百度回收站**管理**接口联网验证（当前对百度后端提示去 App 兜底；删除进原生回收站可用）。
- 发版（合并 `feature/init_proj → dev`、`dev → main` tag + npm/tap/bucket）。

## 命令全集（`bz`）
init/unlock/lock/passwd/recover/login/logout/account · mkdir/ls(`-r`)/push(`--to`/`-r`)/pull(`-r`)/info/rm(回收站,`--yes`)/mv/cp(`-r`)/rename/trash/share/preview
