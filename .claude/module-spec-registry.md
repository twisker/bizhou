# 模块规格登记表

本文件详细记载 **敝帚（Bìzhǒu）** 各模块的使命、设计文档、源码位置与状态。

> 本项目无前端。核心库对外的编程接口（`@bizhou/core`）与 CLI 命令为主要"模块"。
>
> **实施进度（2026-07-23）**：下表所有核心库模块与 CLI 模块均已实现并通过测试（73 项全绿）。
> 各模块最新状态与源码位置以 `.claude/current-sprint.md` 的状态表为准；baidu 对接为"代码完成、联网待验"。

---

## 前端模块索引

不适用（无图形界面）。首期为 CLI + 可嵌入库；未来 GUI 前端可复用 `@bizhou/core`。

---

## 核心库模块索引（`@bizhou/core`）

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| crypto | AES-256-GCM 信封加密、KDF（scrypt/argon2id）派生 KEK、DEK 生成、wrappedKey 包裹/解包、恢复密钥 | PRD §7 | `packages/core/src/crypto/` | 待开始 |
| bundle | `.bz` 目录结构、manifest.json（v1）读写与校验、encMeta（DEK 加密元数据）、不透明 ID | PRD §4/§6 | `packages/core/src/bundle/` | 待开始 |
| chunker | 逻辑分片（默认 100MB，可配置）、`worker_threads` 并行加密、流式不阻塞 | PRD §8.1 | `packages/core/src/chunker/` | 待开始 |
| baidu | 百度开放平台对接：OAuth2、precreate/superfile2/create、list、download、断点续传、退避 | PRD §8/§11 | `packages/core/src/baidu/` | 待开始 |
| preview | 视频抽帧/音频截段/图片缩略生成，单独加密为 preview.part | PRD §9 | `packages/core/src/preview/` | 待开始 |
| export | 7z-AES + 头部加密导出（藏文件名），第三方可脱离本工具解密 | PRD §10 | `packages/core/src/export/` | 待开始 |
| account | 多账号添加/切换，每账号独立 token 与 `/apps/bizhou/` 空间 | PRD §12 | `packages/core/src/account/` | 待开始 |
| keystore | OS 钥匙串封装（Keychain/Credential Manager/Secret Service），缓存 KEK 与 token | PRD §7.3/§12 | `packages/core/src/keystore/` | 待开始 |
| events | 进度事件类型与发射（供 CLI/前端渲染进度） | PRD §5 | `packages/core/src/events/` | 待开始 |
| index | 对外统一 API 出口 | — | `packages/core/src/index.ts` | 待开始 |

---

## CLI 模块索引（`bz`）

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| commands | init/unlock/login/logout/account/push/pull/ls/info/preview/share/rm | PRD §14 | `packages/cli/src/commands/` | 待开始 |
| prompt | 隐藏口令输入、确认交互（绝不回显/记录密钥） | PRD §14 | `packages/cli/src/prompt/` | 待开始 |
| render | 进度条、彩色输出、退出码规范、`--verbose` | 本仓库约定 | `packages/cli/src/render/` | 待开始 |
| skill | 打包为 agent Skill 的清单与入口 | PRD §2/§5 | `packages/cli/src/`（待定） | 待开始 |

---

## 基础设施模块索引

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| 版本钩子 | VERSION 单一事实源 + bump 脚本 + pre-commit 自动 patch | scripts-template | `VERSION` / `scripts/` / `.githooks/` | 稳定 |
| workspace | pnpm monorepo 配置、tsconfig base、构建脚本 | arch-spec §6 | 根目录 | 待开始 |

---

## CI/CD 与部署脚本索引

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| CI 流水线 | lint + 类型 + `bun test` + 构建（三平台矩阵，不触真实网盘） | arch-spec §3 | `.github/workflows/`（待建） | 待开始 |
| 发版流水线 | npm publish `@bizhou/core` + Homebrew tap + Scoop bucket manifest 生成 | PRD §18 / arch-spec §5 | `scripts/`（待建） | 待开始 |

---

## 测试脚本索引

> 待各 Sprint 开发启动后填充（单测位于各包 `test/`，集成测试使用 mock/录制回放的百度接口）。
