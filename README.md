# 敝帚（Bìzhǒu）

> 客户端加密引擎 + 命令行工具（`bz`）。在把文件托付给云存储（百度网盘官方 API）之前，先在本地端到端加密，让云端只存密文、无法解析你的内容；取回时自动解密还原、字节级一致。**隐私优先、数据主权。**

- **平台**：Windows / macOS / Linux
- **技术栈**：TypeScript + Bun（兼容 Node LTS），加密用运行时内置 `crypto`
- **存储后端**：用户自己的百度网盘（官方开放平台 API，沙盒目录 `/apps/bizhou/`）
- **授权**：Apache-2.0
- **状态**：v0.1.0 · 初始化中（Sprint 0 / M0 技术验证）

---

## 它解决什么

云存储会对上传文件做内容检测/扫描。敝帚让你在上传前**先在本地加密**：云端只拿到一坨无法识别的**密文**，读不到真实内容；取回时自动解密还原。密钥全程只在你的设备上，不上传、不托管。

## 安全定性（端到端加密）

- **AES-256-GCM** 加密文件内容（AEAD：机密性 + 防篡改）。
- **信封加密**：每个资源随机生成 **DEK** 加密内容，再用**主密码派生的 KEK** 包裹 DEK。没有主密码，任何人都解不开。
- **机器无关**：换机/重装只需重输主密码。忘主密码用初始化时生成的**恢复密钥**兜底。
- **可审计**：代码中无任何硬编码秘密；算法/KDF 参数公开在 manifest 中。

## 架构

```
┌──────────────────────────┐
│   核心库 @bizhou/core     │  纯逻辑，无交互，发进度事件
│  crypto / bundle / chunker│
│  baidu-api / preview / 7z │
└────────────┬─────────────┘
             │
      ┌──────▼──────┐
      │  CLI (`bz`)  │  薄包装；可测、可脚本化、可发布为 agent Skill
      └─────────────┘
```

- **核心库 `@bizhou/core`**：加密、bundle/manifest、分片、百度对接、预览、7z 导出。只发进度事件、不打印；无 UI/CLI 依赖，可被任意前端或自动化嵌入。
- **CLI `bz`**：核心库的命令行包装，可测、可脚本化、可作为 agent Skill 调用。

## 数据模型

每个"资源"物理上是一个带 `.bz` 后缀的 **Bundle 文件夹**（在别的客户端里显示为普通文件夹）：

```
/apps/bizhou/<opaque-id>.bz/
  ├── manifest.json     # 分片信息 + wrappedKey + 加密元数据 + 预览指向
  ├── 000.part          # 加密分片（默认每片 ≤100MB）
  ├── 001.part
  └── preview.part      # 加密预览包（可选）
```

文件夹名不透明、不含原文件名；原文件名只存在（加密的）manifest 里。

## CLI 一览（`bz`）

| 命令 | 说明 |
|---|---|
| `bz init` | 首次设置主密码，生成恢复密钥 |
| `bz unlock` | 输入主密码解锁本设备会话（缓存至 OS 钥匙串） |
| `bz login` / `bz logout` | OAuth 登录 / 注销百度账号 |
| `bz account [list\|use <name>\|add]` | 多账号管理与切换 |
| `bz push <path> [--no-split] [--chunk 100MB] [--compress]` | 加密 + bundle + 上传 |
| `bz pull <name\|id> [--out <dir>]` | 下载 + 解密 + 合并还原 |
| `bz ls [path]` / `bz info <name\|id>` | 列出资源 / 查看元数据 |
| `bz preview <name\|id>` | 拉取并展示预览包 |
| `bz share <name\|id> [--code\|--7z]` | 生成分享码 / 导出 7z-AES 单包 |
| `bz rm <name\|id>` | 删除资源 |

## 目录结构（pnpm monorepo）

```
bizhou/
├── packages/core/   # @bizhou/core —— 纯逻辑核心库
├── packages/cli/    # bz —— CLI 薄包装
├── design/PRD.md    # 产品需求文档
├── scripts/         # 版本 bump + 发版脚本
├── .githooks/       # pre-commit（自动 patch 版本）
└── .claude/         # AI-Human 协作框架与登记表
```

## 前置准备

1. 安装 [Bun](https://bun.sh)（主运行时；核心库亦兼容 Node LTS）与 pnpm。
2. 自备**百度网盘开放平台应用凭证**（AppKey/SecretKey）——工具不内嵌任何凭证。`cp .env.example .env` 后填入。

## 开发与测试

```bash
pnpm install            # 安装 workspace 依赖
pnpm run typecheck      # 两包 TypeScript 类型检查
bun test               # 运行全部测试（当前 73 项全绿）
```

离线体验（用本地目录代替百度网盘，无需登录/网络）：

```bash
IDX=packages/cli/src/index.ts
export BIZHOU_CONFIG_DIR=/tmp/bz-demo BIZHOU_MASTER_PASSWORD=demo-pass
bun $IDX init
bun $IDX push ./任意文件.pdf --local /tmp/bz-store --compress
bun $IDX ls   --local /tmp/bz-store
bun $IDX pull <资源ID> --local /tmp/bz-store --out /tmp/bz-out   # 还原字节级一致
```

联网使用则先 `bun $IDX login`（OAuth），之后 push/pull 省略 `--local` 即走百度网盘。

## 状态

- ✅ **已完成（离线可验证）**：加密内核（AES-256-GCM 信封 + scrypt + MK/恢复密钥）、bundle/manifest、分片器、完整加密往返（字节级一致）、百度对接层（mock 测试）、多账号、CLI 全命令、ffmpeg 预览、7z-AES 导出、三平台 CI。
- ⏳ **待人工联网验证**：M0 真实 OAuth + 上传/下载往返 + 确认云端不限制加密大文件、QPS/配额实测、真实 >4GB 断点续传、第三方 7-Zip 解密验证。见 `人工TODO事项.md`。

## 路线图

- **M0（Sprint 0）** — 技术验证：跑通 OAuth + 上传/下载往返字节一致，验证云端不限制加密大文件。
- **M1（Phase 1）** — 核心库 + CLI 全 pipeline；预览、7z-AES 导出、多账号；>4GB 大文件与断点续传。
- **Phase 2** — 生态与打磨：shell 补全、更多预览、daemon/定时备份、GUI 前端、进 homebrew-core/winget，远期移动端。

详见 `.claude/sprint-plan.md`。

## 授权

[Apache-2.0](./LICENSE)
