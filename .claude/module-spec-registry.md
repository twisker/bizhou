# 模块规格登记表

本文件详细记载 **敝帚（Bìzhǒu）** 各模块的使命、设计文档、源码位置与状态。

> 本项目无前端。核心库对外的编程接口（`@bizhou/core`）与 CLI 命令为主要"模块"。
>
> **实施进度（2026-07-23）**：M0/M1 全部核心库/CLI 模块已实现并通过测试（`bun test` 76 项全绿 + 1 skip）。
> 各模块最新状态与源码位置以 `.claude/current-sprint.md` 的状态表为准；baidu 对接为"代码完成、联网待验"。

---

## 前端模块索引

不适用（无图形界面）。首期为 CLI + 可嵌入库；未来 GUI 前端可复用 `@bizhou/core`。

---

## 核心库模块索引（`@bizhou/core`）

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| crypto | AES-256-GCM 信封、scrypt KDF（NFKC）、wrap/unwrap、base32 恢复密钥编码 | PRD §7 | `packages/core/src/crypto/`（含 `base32.ts`） | ✅ 稳定 |
| vault | 主密钥 MK + 主密码/恢复密钥双路解锁 + 改密（信封稳健化，见 tech-spec §5.1） | PRD §7 | `packages/core/src/vault/` | ✅ 稳定 |
| bundle | `.bz` 目录结构、manifest.json（v1）读写与校验、encMeta（DEK 加密元数据）、不透明 ID | PRD §4/§6 | `packages/core/src/bundle/` | ✅ 稳定 |
| chunker | 逻辑分片（默认 100MB，可配置）、流式不阻塞（内存与文件大小解耦）；**worker_threads 并行未实现，属后续优化** | PRD §8.1 | `packages/core/src/chunker/` | ✅ 稳定 |
| store | BundleStore 抽象 + Local/Memory 实现（存储无关，pack/unpack 复用） | 本仓库约定 | `packages/core/src/store/` | ✅ 稳定 |
| resource | pack/unpack 编排（DEK→encMeta→分片→manifest）、openPreview | 本仓库约定 | `packages/core/src/resource/` | ✅ 稳定 |
| baidu | OAuth2、precreate/superfile2/create、list/filemetas/download/delete、断点续传、退避重试、BaiduBundleStore | PRD §8/§11 | `packages/core/src/baidu/` | ✅ 稳定 |
| preview（加密/解密） | 预览包用 DEK 加密存 preview.part、openPreview 还原（**生成 ffmpeg 在 CLI 层**） | PRD §9 | `packages/core/src/resource/index.ts` | ✅ 稳定 |
| account | 多账号 token、当前账号、解锁 MK 缓存 | PRD §12 | `packages/core/src/account/` | ✅ 稳定 |
| keystore | SecretStore 接口 + FileSecretStore（设备密钥 AES-GCM 加密落盘）+ Memory | PRD §7.3/§12 | `packages/core/src/keystore/` | ✅ 稳定 |
| config | 配置根解析：**密钥根 `~/.bizhou` + 文件根=下载目录（均可配）**（env/platform 注入，纯函数） | 本仓库约定 / spec 2026-07-23 | `packages/core/src/config/` | ✅ 稳定 |
| events | 进度事件类型与回调 | PRD §5 | `packages/core/src/events/` | ✅ 稳定 |
| index | 对外统一 API 出口 | — | `packages/core/src/index.ts` | ✅ 稳定 |
| cloudpath | 云端路径纯函数（normalize/join/dirname/basename/split；**拒绝 `..` 防穿越**） | spec 2026-07-23 | `packages/core/src/cloudpath/` | ✅ 稳定（v2-P1） |
| backend | 文件系统级 Backend 抽象 + LocalBackend + BaiduBackend（mkdir/listDir/bundleStore） | spec 2026-07-23 | `packages/core/src/backend/` | ✅ 稳定（v2-P1） |

---

## CLI 模块索引（`bz`）

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| commands | init/unlock/lock/passwd/recover/login/logout/account/push/pull/ls/info/rm/share/preview | PRD §14 | `packages/cli/src/commands.ts` | ✅ 稳定 |
| runtime | .env 加载、配置目录、SecretStore/账号装配、MK 解析、Baidu 客户端（token 刷新） | 本仓库约定 | `packages/cli/src/runtime.ts` | ✅ 稳定 |
| prompt | 隐藏口令输入、`--password-stdin`/环境变量 | PRD §14 | `packages/cli/src/prompt.ts` | ✅ 稳定 |
| render | 颜色、进度条、字节格式化、退出码映射 | 本仓库约定 | `packages/cli/src/render.ts` | ✅ 稳定 |
| preview（生成） | ffmpeg 图片/视频缩略、音频片段 | PRD §9 | `packages/cli/src/preview.ts` | ✅ 稳定 |
| export7z | 7z-AES 头部加密导出（依赖 7z 二进制，防参数注入） | PRD §10 | `packages/cli/src/export7z.ts` | ✅ 稳定 |
| skill | bz 作为 agent Skill 的非交互调用说明 | PRD §2/§5 | `packages/cli/skill/SKILL.md` | ✅ 稳定 |

---

## 基础设施模块索引

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| 版本钩子 | VERSION 单一事实源 + bump 脚本 + pre-commit 自动 patch | scripts-template | `VERSION` / `scripts/` / `.githooks/` | 稳定 |
| workspace | pnpm monorepo 配置、tsconfig base、构建脚本 | arch-spec §6 | 根目录 | ✅ 稳定 |

---

## CI/CD 与部署脚本索引

| 模块 | 说明 | 设计文档 | 源代码目录 | 状态 |
|------|------|---------|----------|------|
| CI 流水线 | lint + 类型 + `bun test` + 构建（三平台矩阵，不触真实网盘） | arch-spec §3 | `.github/workflows/ci.yml` | ✅ 稳定 |
| 构建 | tsup 构建两包（core→ESM+d.ts；CLI→自包含）+ publishConfig | arch-spec §5 | `packages/*/tsup.config.ts` | ✅ 稳定 |
| 发版脚本 | 生成 tarball + Homebrew formula + Scoop manifest | PRD §18 | `scripts/gen-packaging.sh` | ⏳ 生成就绪，publish 待 H-05 |

---

## 测试脚本索引

> 待各 Sprint 开发启动后填充（单测位于各包 `test/`，集成测试使用 mock/录制回放的百度接口）。
