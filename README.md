<!-- 语言 / Language: **中文** · [English](./README.en.md) -->

# 敝帚（Bìzhǒu）

> 客户端加密引擎 + 命令行工具（`bz`）。在把文件托付给云存储（百度网盘官方 API）之前，先在本地端到端加密，让云端只存密文、无法解析你的内容；取回时自动解密还原、字节级一致。**隐私优先、数据主权。**

- **平台**：Windows / macOS / Linux
- **技术栈**：TypeScript + Bun（兼容 Node LTS），加密用运行时内置 `crypto`
- **存储后端**：用户自己的百度网盘（官方开放平台 API，沙盒目录 `/apps/bizhou/`）
- **授权**：Apache-2.0
- **状态**：**已发布 v1.0.0**（加密内核 + 完整 CLI + 云端文件系统层 + 并发/续传/去重 + 备份守护 + shell 补全 + 多类型预览）；`bun test` 全绿。npm / Homebrew / Scoop 均可安装
- **文档站**：<https://twisker.github.io/bizhou/>（中文 / English）

---

## 它解决什么

云存储会对上传文件做内容检测/扫描，也可能因内容而限制或封禁。敝帚让你在上传前**先在本地加密**：云端只拿到一坨无法识别的**密文**，读不到真实内容；取回时自动解密还原。密钥全程只在你的设备上——不上传、不托管。

## 安全定性（端到端加密）

- **AES-256-GCM** 加密文件内容（AEAD：机密性 + 防篡改；任何篡改/错误口令都会校验失败而报错，绝不返回损坏数据）。
- **信封 + 主密钥 MK 间接**：每个资源随机生成 **DEK** 加密内容；一把随机 **主密钥 MK** 用来包裹各资源 DEK；MK 再被「主密码派生的 KEK」和「恢复密钥」各包裹一份。改主密码只需重包 MK，不动任何资源；忘主密码用**恢复密钥**兜底。
- **内容身份不泄露**：去重用的内容指纹是 `HMAC(派生自 MK 的密钥, 明文)`，只存进**加密的**元数据，云端零可见——攻击者即使握有候选明文也无法确认你存了什么。
- **机器无关**：换机/重装只需重输主密码。
- **可审计**：代码中无任何硬编码秘密；算法/KDF/IV 方案公开在 manifest 与 `.claude/tech-spec-registry.md`。

## 主要能力

- **加密上传 / 还原下载**：可选压缩 → AES-256-GCM 加密 → 逻辑分片（默认 100MB）→ bundle → 上传；下载自动合并解密、**字节级一致**。
- **并发上传**：片内 4MB 传输分片限流池并发，提吞吐（`--concurrency`，默认 4）。
- **断点续传**：上传/下载中断可续（复用同一 DEK 与分片；下载走临时文件 + 原子落地 + 端到端校验）。
- **内容去重 + 在飞锁**：同内容已在目标目录则跳过；同内容正在传则提醒结束——防重复上传。
- **云端文件系统层**：真实目录树（云端与本地都是真实目录）；`mkdir` / `ls -r` / `mv` / `cp -r` / `rename`；删除进**回收站**（`trash` 管理）；`-r` 递归整树加密备份 / 还原。
- **备份守护 `bz daemon`**：注册备份任务后，前台守护「启动即扫 + 实时监听（变更即备份）+ 定时兜底」；备份语义**永不删云**。
- **shell 补全**：`bz completion <bash|zsh|powershell>`——命令/子命令/flag 静态补全 + 备份 id/账号名本地动态补全。
- **多类型预览**：图片/视频缩略、音频片段、**PDF 首页**（落文件）；**文本/代码前 32KB、压缩包文件列表**（`bz preview` 直接打 stdout）。预览独立加密存储、云端零可见。
- **分享**：`bz share --code`（导出资源 DEK 分享码）/ `--7z`（7z-AES 单包，第三方可解）。
- **多账号**：`bz account`，每账号独立 token 与 `/apps/bizhou/` 空间。

## 架构

```
┌──────────────────────────────────────────────┐
│            核心库 @bizhou/core                 │  纯逻辑，无交互，只发进度事件、绝不 print
│  crypto · bundle · chunker · content(指纹)     │
│  journal(锁+续传) · cache · backup · backend    │
│  baidu-api · resource · vault · account         │
└───────────────────────┬──────────────────────┘
                        │
                 ┌──────▼──────┐
                 │  CLI (`bz`)  │  薄包装；口令/交互/预览生成/守护/补全均在此
                 └─────────────┘
```

- **核心库 `@bizhou/core`**：加密、bundle/manifest、分片、内容指纹、上传日志（锁+续传）、manifest 缓存、备份任务模型、后端抽象（本地 / 百度）、百度对接、预览存储、7z 导出。只发进度事件、不打印、不读时钟、不用 Bun 专有 API——可被任意前端或自动化嵌入，Node LTS 下等价运行。
- **CLI `bz`**：核心库的命令行包装。口令输入、进度渲染、预览生成（ffmpeg/pdftoppm 等可选外部工具）、`daemon` 守护、shell 补全脚本生成都在 CLI 层。

## 数据模型

每个「资源」物理上是一个带 `.bz` 后缀的 **Bundle 文件夹**（在别的客户端里显示为普通文件夹）：

```
/apps/bizhou/<可配置目录树>/<opaque-id>.bz/
  ├── manifest.json     # 分片信息 + wrappedKey + 加密元数据(含内容指纹) + 预览指向
  ├── 000.part          # 加密分片（默认每片 ≤100MB）
  ├── 001.part
  └── preview.part      # 加密预览包（可选）
```

- 文件夹名不透明、不含原文件名；原文件名与内容指纹只存在**加密的** `encMeta` 里。
- 云端保留**随机 bundle 名**（隐私）；本地/`bz ls` 显示**真名**（从解密的 encMeta 读出）。
- 本地两个可配置根：**密钥根**（默认 `~/.bizhou`，环境变量 `BIZHOU_HOME`）存密钥/账号/配置；**文件根**（默认系统下载目录，`BIZHOU_FILE_ROOT`）存下载还原的文件。

## 快速开始

[安装](#安装) `bz` 后：

```bash
bz init                          # 设主密码，生成恢复密钥（务必抄下恢复密钥）
bz login                         # 浏览器 OAuth 登录百度

bz push ./重要资料.zip --preview   # 加密上传 → 输出资源 ID
bz ls                            # 列出资源（显示真名）
bz preview <资源ID>               # 预览（文本/压缩包列表打印，媒体/PDF 落文件）
bz pull <资源ID>                  # 还原到文件根，字节级一致

bz push ./某目录 -r --to /工作     # 整个目录树加密备份
```

完整教程见[文档站 · 快速开始](https://twisker.github.io/bizhou/zh/quickstart.html)。

## CLI 一览（`bz`）

| 命令 | 说明 |
|---|---|
| `bz init` / `unlock` / `lock` / `passwd` / `recover` | 主密码、恢复密钥、会话解锁/上锁、改密 |
| `bz login` / `logout` / `account [list\|use <n>\|add <n>]` | 百度 OAuth 登录、注销、多账号 |
| `bz push <path> [-r] [--to <云端目录>] [--chunk] [--compress] [--no-split] [--name] [--preview] [--force] [--concurrency N]` | 加密上传（`-r` 整树；去重/续传/在飞锁/并发） |
| `bz pull <id\|云端目录> [-r] [--out <dir>] [--force]` | 下载还原到文件根（幂等/续传/端到端校验/原子落地） |
| `bz mkdir <目录>` / `ls [目录] [-r]` / `info <id>` | 建目录 / 列目录（真名）/ 看元数据 |
| `bz mv <src> <目标目录>` / `cp <src> <目标目录> [-r]` / `rename <src> <新名>` | 移动 / 复制 / 改名 |
| `bz rm <路径\|id> [--yes]` / `trash [list\|restore <id>\|rm <id>\|clear]` | 删除到回收站 / 回收站管理 |
| `bz share <id> [--code\|--7z]` / `preview <id> [--out <dir>]` | 分享码 / 7z-AES 导出 / 多类型预览 |
| `bz backup add <目录> [--to]` / `list` / `rm <id>` / `run [<id>]` | 注册/管理/手动执行加密备份任务 |
| `bz daemon` | 前台守护：启动即扫 + 实时监听 + 定时兜底备份 |
| `bz completion <bash\|zsh\|powershell>` | 输出 shell 补全脚本 |

通用选项：`--local <dir>`（本地/自建后端）、`--password-stdin`（脚本化读口令）、`-h/--help`、`-v/--version`。完整参考见文档站的**命令参考**。

## 安装

安装后的 `bz` 运行需要 **Node.js**。

```bash
# npm（跨平台）
npm i -g @bizhou/cli
#   或一次性：npx @bizhou/cli --help

# Homebrew（macOS / Linux）
brew tap twisker/bizhou && brew install bizhou

# Scoop（Windows）
scoop bucket add bizhou https://github.com/twisker/scoop-bizhou && scoop install bizhou
```

装完 `bz --version` 应为 `1.0.0`。从源码运行见「快速开始」。详见[文档站 · 安装](https://twisker.github.io/bizhou/zh/install.html)。

## 前置准备

1. 安装 [Bun](https://bun.sh)（主运行时；核心库亦兼容 Node LTS）与 pnpm。
2. 自备**百度网盘开放平台应用凭证**（AppKey/SecretKey）——工具不内嵌任何凭证。`cp .env.example .env` 后填入 `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`。
3. （可选）预览外部工具：`ffmpeg`（音视频/图片缩略）、`pdftoppm`（poppler，PDF 首页）。缺失时相应预览优雅跳过，不影响上传。

## 开发与测试

```bash
pnpm install            # 安装 workspace 依赖
pnpm run typecheck      # 两包 TypeScript 类型检查
bun test                # 运行全部测试（当前 200+ 项全绿）
pnpm run build          # 构建 core（ESM+d.ts）与自包含 CLI
```

## 文档

- **文档站（GitHub Pages，中文 / English）**：<https://twisker.github.io/bizhou/> —— 安装、快速开始、核心概念、命令参考、备份守护/分享/补全教程、安全模型、FAQ。
- 内部协作与规格：`.claude/`、`design/PRD.md`（面向贡献者/AI 协作）。

## 路线图

- ✅ **M0** — 技术验证：真实百度网盘 500MB 加密文件往返字节一致、云端不限制加密大文件。
- ✅ **M1** — 核心库 + CLI 全 pipeline；预览、7z-AES 导出、多账号；>4GB 大文件。
- ✅ **v2** — 云端文件系统层：真实目录树、双可配本地根、`mv/cp/rename`、回收站、`-r` 递归整树。
- ✅ **Phase 3（打磨与生态，仅 CLI）** — 健壮上传（并发/续传/去重/在飞锁）、健壮下载（幂等/分片续传/端到端校验）、daemon/定时备份、shell 补全、更多预览类型。
- ✅ **发布** — v1.0.0 已发布：GitHub Release + npm（`@bizhou/cli`/`@bizhou/core`）+ Homebrew tap + Scoop bucket + 文档站。
- ⏳ **后续** — 进 homebrew-core / winget（待用户量）。

## 授权

[Apache-2.0](./LICENSE)
