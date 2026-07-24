# 架构规格登记表

本文件记载 **敝帚（Bìzhǒu）** 的技术架构规格：系统分层、环境规划、CI/CD、可观测性、版本与分发。

> 注：本项目为**开源 CLI + 可嵌入库**，非在线 Web 服务。传统的 staging/gray/prod 服务器矩阵在此不适用；"环境"与"发布"围绕 **开发 → CI → npm/Homebrew/Scoop 发版** 展开。

---

## 1. 架构总览

### 系统分层

| 层级 | 说明 | 核心技术 |
|------|------|---------|
| Layer 1 · 核心库 `@bizhou/core` | 纯逻辑、无交互、只发进度事件、无 UI/CLI 依赖；可被任意前端/自动化嵌入 | TypeScript、内置 `crypto`、`worker_threads` |
| Layer 2 · CLI `bz` | 核心库的薄命令行包装；可测、可脚本化、可发布为 agent Skill | TypeScript、Bun/Node、OAuth 本地回调 |
| 外部依赖 · 百度网盘 | 用户自己的网盘空间（`/apps/bizhou/`），官方开放平台 API | REST + OAuth2 |
| 本地存储 · OS 钥匙串 | 缓存派生 KEK 与 OAuth token | Keychain / Credential Manager / Secret Service |

```
┌──────────────────────────┐
│   核心库 @bizhou/core     │  纯逻辑，无交互，发进度事件
│  crypto / bundle / chunker│
│  baidu-api / preview / 7z │
└────────────┬─────────────┘
             │
      ┌──────▼──────┐
      │  CLI (`bz`)  │  薄包装；可测、可脚本化、可发布为 Skill
      └─────────────┘
```

### 核心设计原则

- **分层解耦**：核心库只发进度事件、绝不 `print`；所有交互（口令输入、确认、进度渲染）留在 CLI 层。
- **对接层隔离**：百度 API 封装在独立模块，接口/政策变动只需改一处，便于适配。
- **端到端加密、密钥不出端**：DEK/KEK/主密码全程客户端，云端只见密文。
- **零外部二进制依赖（加密路径）**：AES/KDF 用运行时内置库，跨平台一致、可审计。
- **可嵌入优先**：核心库不绑定 Bun 专有 API，保证 Node LTS 下等价运行，可被 daemon/定时备份等自动化复用（本项目自身只做 CLI）。

---

## 2. 环境规划

### 环境矩阵（适配 CLI/库项目）

| 环境 | 标识 | 用途 | 数据层 | 发布方式 |
|------|------|------|--------|---------|
| 本地开发 | `local` | 开发调试、单测 | 开发者本机 + 测试用百度账号/沙盒目录 | 手动 `bun run` |
| CI | `ci` | Lint + 类型检查 + 测试 + 构建 | mock/录制的百度接口（不依赖真实网盘） | push/PR 自动触发 |
| 预发布验证 | `rc` | 发版前手动冒烟：真实账号跑通 push/pull 往返 | 真实百度账号（测试专用） | 打 `-rc` tag 手动验证 |
| 正式发布 | `release` | 面向用户的稳定版本 | 用户自己的百度账号 | 打正式 tag → 自动发 npm + Homebrew/Scoop manifest |

> 因涉及真实网盘配额与限流，凡触达真实百度接口的测试（M0 验证、`rc` 冒烟）均由**人工用测试账号**执行，不放入自动 CI。

---

## 3. CI/CD 流水线

### 流水线概览

| 触发条件 | 执行内容 | 目标 |
|---------|---------|---------|
| push / PR | Lint + 类型检查 + 单元测试 + 构建 + 依赖漏洞扫描 | `ci`（不触真实网盘） |
| 打 `vX.Y.Z-rc.N` tag | 人工用测试账号跑真实往返冒烟 | `rc` |
| 打 `vX.Y.Z` 正式 tag（人工审批） | 构建产物晋升：发布 `@bizhou/core` 到 npm + 生成 Homebrew tap / Scoop bucket manifest | `release` |

### CI 阶段（自动）

1. **代码质量**：ESLint + Prettier/Biome + 类型检查（tsc --noEmit）+ 依赖漏洞扫描（`pnpm audit`）
2. **测试**：`bun test`（单元 + 用 mock/录制回放的百度接口集成测试）+ **字节级往返一致性**测试
3. **构建**：`packages/core` 与 `packages/cli` 分别构建（tsup/bun build），产出可发布产物
4. **多平台校验**：在 Linux/macOS/Windows runner 上跑构建 + 单测（保证三平台一致）

### CD 阶段（人工）

- **RC 冒烟**：用测试百度账号手动跑通 `bz init → login → push 大文件 → pull → 字节一致`；记录 QPS/配额实测。
- **正式发布**：人工审批后打 tag → CI 自动 `npm publish @bizhou/core` + 更新 Homebrew tap 与 Scoop bucket 的 manifest（含校验和）。

---

## 4. 可观测性

| 层级 | 工具 / 方式 |
|------|------|
| CLI 运行 | 结构化日志（可 `--verbose`）；**绝不记录**主密码/密钥/token/文件明文 |
| 加密链路自检 | 每分片 SHA-256 + GCM tag 校验；往返一致性断言 |
| 上传/下载 | 进度事件（分片进度、断点续传状态、重试/退避计数） |
| 错误 | 分类退出码 + 可读错误消息（网络 / 鉴权 / 密钥 / 参数 / 配额限流） |
| 发布 | 发版流水线日志 + 产物校验和（sha256）记录 |

---

## 5. 版本管理与发布

### 版本格式

`major.minor.patch`（如 `1.2.34`）；根 `VERSION` 文件为单一事实源，两个包版本与之对齐。

### 自动管理规则

| 版本段 | 更新方式 | 触发条件 |
|--------|---------|---------|
| patch | 自动（git pre-commit hook） | 每次 `git commit`（有非 VERSION 变更时） |
| minor | 人工脚本 | 人工调用 `scripts/bump-minor.sh` |
| major | 人工脚本 | 人工调用 `scripts/bump-major.sh` |

### 分发渠道

- **核心库**：npm 包 `@bizhou/core`。
- **CLI（`bz`）**：自建 **Homebrew tap** + **Scoop bucket**，发版自动生成 manifest；后续再进 homebrew-core / winget 扩大触达。
- **授权**：Apache-2.0。

---

## 6. 项目目录结构（推荐，pnpm monorepo）

```
bizhou/
├── VERSION                     # 单一版本事实源（0.1.0 起）
├── package.json                # 根：pnpm workspace 配置
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── CLAUDE.md
├── LICENSE                     # Apache-2.0
├── 人工TODO事项.md
├── design/
│   └── PRD.md
├── packages/
│   ├── core/                   # @bizhou/core —— 纯逻辑核心库
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── crypto/         # AES-256-GCM 信封、KDF、DEK/KEK、恢复密钥
│   │   │   ├── bundle/         # .bz 结构、manifest 读写/校验
│   │   │   ├── chunker/        # 100MB 逻辑分片、worker_threads
│   │   │   ├── baidu/          # OAuth2 + xpan/file + superfile2 + download
│   │   │   ├── preview/        # 视频/音频/图片预览生成 + 加密
│   │   │   ├── export/         # 7z-AES 头部加密导出
│   │   │   ├── account/        # 多账号管理
│   │   │   ├── keystore/       # OS 钥匙串封装（KEK/token 缓存）
│   │   │   ├── events/         # 进度事件类型与发射
│   │   │   └── index.ts        # 对外 API
│   │   └── test/
│   └── cli/                    # bz —— CLI 薄包装
│       ├── package.json        # bin: bz
│       ├── src/
│       │   ├── commands/       # init/unlock/login/logout/account/push/pull/ls/info/preview/share/rm
│       │   ├── prompt/         # 隐藏口令输入、确认交互
│       │   ├── render/         # 进度条、彩色输出、退出码
│       │   └── index.ts
│       └── test/
├── scripts/                    # bump-patch/minor/major.sh + 发版脚本
├── .githooks/                  # pre-commit（自动 patch）
└── .claude/                    # 协作框架与登记表
```
