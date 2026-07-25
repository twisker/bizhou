---
title: 安装与前置
parent: 中文文档
nav_order: 1
---

# 安装与前置

## 安装 `bz`

> 安装后的 `bz` 运行需要 **Node.js**。下面各方式会自动装依赖或提示。装完直接用 `bz`。

### A. 包管理器（推荐）

**npm（跨平台）**
```bash
npm i -g @bizhou/cli      # 全局安装，之后直接用 bz
bz --version              # → 1.1.0
```
或一次性运行、无需安装：
```bash
npx @bizhou/cli --help
```

**Homebrew（macOS / Linux）**
```bash
brew tap twisker/bizhou
brew install bizhou       # 自动装 node 依赖
bz --version
```

**Scoop（Windows）**
```powershell
scoop bucket add bizhou https://github.com/twisker/scoop-bizhou
scoop install bizhou      # 依赖 nodejs
bz --version
```

> 也可从 [GitHub Release](https://github.com/twisker/bizhou/releases/latest) 下载 `bizhou-cli-*.tgz` 手动安装。

### 升级到新版

```bash
npm i -g @bizhou/cli@latest          # npm
brew update && brew upgrade bizhou   # Homebrew
scoop update bizhou                  # Scoop
```

`bz` **不联网检查版本、不自动更新**（不向外发任何信标是有意的设计，见[安全模型](./security.html)），升级完全由你的包管理器驱动。各版本差异、兼容性承诺与历史版本下载见[版本与兼容性](./versions.html)。

> **从 v1.0.x 升上来的用户**：升级后跑一次 `bz vault sync`，把保险库加密上云——这是"换机只需重输主密码"的前提。不做也能继续用，但换机 / 重装 / 硬盘损坏会让云端数据永久锁死。

### B. 从源码（开发 / 尝鲜）

需 [Bun](https://bun.sh)（核心库亦兼容 Node LTS）与 pnpm：
```bash
git clone https://github.com/twisker/bizhou.git
cd bizhou
pnpm install
bun packages/cli/src/index.ts --help   # 从源码运行时用它代替 `bz`
```

> 下文命令一律写作 `bz`。若你走「从源码」，把 `bz` 换成 `bun packages/cli/src/index.ts`。

## 百度网盘凭证（联网使用才需要）

工具**不内嵌任何凭证**——你需要自备百度网盘开放平台应用的 AppKey / SecretKey：

- **包管理器安装**：在 `bz` 的密钥根（默认 `~/.bizhou`）下放一个 `.env`，或用环境变量 `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`。
- **从源码**：项目根 `cp .env.example .env` 后填入。

```
BAIDU_APP_KEY=你的AppKey
BAIDU_SECRET_KEY=你的SecretKey
```

> 使用本地/自建后端（`--local`）时无需百度凭证。

## 可选：预览外部工具

多类型预览在 CLI 层调用可选外部工具，**缺失时对应预览优雅跳过，不影响上传**：

| 工具 | 用于 | 覆盖环境变量 |
|---|---|---|
| `ffmpeg` | 图片/视频缩略图、音频片段 | `BIZHOU_FFMPEG_BIN` |
| `pdftoppm`（poppler） | PDF 首页缩略图 | `BIZHOU_PDFTOPPM_BIN` |

文本/代码预览与压缩包文件列表**零外部依赖**（纯内置实现）。

## 目录根（可配置）

敝帚在本地用两个可配置的「根」：

| 根 | 存什么 | 默认 | 环境变量 |
|---|---|---|---|
| 密钥根 | 密钥、账号、配置、备份任务、上传日志 | `~/.bizhou` | `BIZHOU_HOME` |
| 文件根 | 下载还原后的文件 | 系统「下载」目录 | `BIZHOU_FILE_ROOT` |

## 验证安装

```bash
bz --version     # → 1.0.0
bz --help        # 看全部命令
```

下一步 → [快速开始](./quickstart.html)
