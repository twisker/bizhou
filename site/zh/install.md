---
title: 安装与前置
parent: 中文文档
nav_order: 1
---

# 安装与前置

## 1. 运行时

- **[Bun](https://bun.sh)**（主运行时）与 **pnpm**（monorepo 包管理）。
- 核心库 `@bizhou/core` 亦兼容 **Node LTS**；CLI 目前以 Bun 运行为主。

## 2. 获取源码并安装依赖

```bash
git clone https://github.com/twisker/bizhou.git
cd bizhou
pnpm install
```

正式发布渠道（npm `@bizhou/cli`、Homebrew tap、Scoop bucket）打包脚本已就绪，正式发布待触发；当前从源码运行。

## 3. 百度网盘凭证（联网使用才需要）

工具**不内嵌任何凭证**——你需要自备百度网盘开放平台应用的 AppKey / SecretKey：

```bash
cp .env.example .env
# 编辑 .env，填入：
# BAIDU_APP_KEY=你的AppKey
# BAIDU_SECRET_KEY=你的SecretKey
```

> `.env` 已被 `.gitignore` 忽略、绝不入库。只做**离线体验**（`--local`）时无需凭证。

## 4. 可选：预览外部工具

多类型预览在 CLI 层调用可选外部工具，**缺失时对应预览优雅跳过，不影响上传**：

| 工具 | 用于 | 覆盖环境变量 |
|---|---|---|
| `ffmpeg` | 图片/视频缩略图、音频片段 | `BIZHOU_FFMPEG_BIN` |
| `pdftoppm`（poppler） | PDF 首页缩略图 | `BIZHOU_PDFTOPPM_BIN` |

文本/代码预览与压缩包文件列表**零外部依赖**（纯内置实现）。

## 5. 目录根（可配置）

敝帚在本地用两个可配置的「根」：

| 根 | 存什么 | 默认 | 环境变量 |
|---|---|---|---|
| 密钥根 | 密钥、账号、配置、备份任务、上传日志 | `~/.bizhou` | `BIZHOU_HOME` |
| 文件根 | 下载还原后的文件 | 系统「下载」目录 | `BIZHOU_FILE_ROOT` |

## 6. 验证安装

```bash
pnpm run typecheck    # 类型检查
bun test              # 全部测试（当前 200+ 全绿）
bun packages/cli/src/index.ts --help    # 看帮助
```

下一步 → [快速开始](./quickstart.html)
