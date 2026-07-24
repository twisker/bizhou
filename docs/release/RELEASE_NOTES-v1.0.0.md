# 敝帚 Bìzhǒu v1.0.0

> 客户端加密引擎 + 命令行工具（`bz`）——上传前本地端到端加密，云端只存密文；取回自动解密还原、字节级一致。
> A client-side encryption engine + CLI (`bz`) — encrypt locally before upload so the cloud only stores ciphertext; retrieval decrypts automatically, byte-for-byte identical.

**首个正式版本 · First stable release** · Apache-2.0 · Windows / macOS / Linux

文档 / Docs: <https://twisker.github.io/bizhou/>

---

## 中文

### 亮点
把文件托付给百度网盘之前，先在本地 **AES-256-GCM 端到端加密**——云端只拿到无法识别的密文，读不到你的内容；密钥全程只在你的设备上。v1.0.0 功能完备、`bun test` 全绿。

### 能力总览

**加密内核**
- AES-256-GCM 信封加密；scrypt 口令派生；主密钥 MK 间接（改密只重包 MK、忘密码用恢复密钥）；零外部加密依赖（运行时内置 `crypto`）。
- 逻辑分片（默认 100MB，可调），内存与文件大小解耦；>4GB 大文件往返字节一致。

**完整 CLI（`bz`）**
- 密钥/会话：`init` / `unlock` / `lock` / `passwd` / `recover`。
- 账号：`login` / `logout` / `account`（多账号，各自独立空间）。
- 上传/下载：`push` / `pull`，进度条、`--chunk`/`--compress`/`--no-split`/`--name`。

**云端文件系统层（v2）**
- 真实目录树（云端与本地都是真实目录）：`mkdir` / `ls -r` / `mv` / `cp -r` / `rename`。
- 删除进**回收站**（`trash list/restore/rm/clear`）。
- `-r` 递归整树加密备份 / 还原；云端随机名 + 本地真名显示；双可配本地根（密钥根 `~/.bizhou` + 文件根=下载目录）。

**健壮上传（Phase 3 · S1）**
- 片内 4MB 分片**并发上传**（`--concurrency`，默认 4）。
- **断点续传**（复用同一 DEK + 已传分片）。
- **内容去重 + 在飞锁**：同内容已在/正在传则跳过，防重复上传。

**健壮下载（Phase 3 · S2）**
- **幂等**（目标已有相同内容则跳过）、**分片断点续传**、临时文件 + **原子落地**、**端到端 contentId 校验**（绝不交付半份/损坏文件）。

**备份守护（Phase 3 · D1）**
- `bz backup add/list/rm/run` 注册加密备份任务；`bz daemon` 前台守护（启动即扫 + 实时监听 + 定时兜底）；**备份语义永不删云**。

**shell 补全（Phase 3 · C1）**
- `bz completion <bash|zsh|powershell>`——命令/子命令/flag 静态补全 + 备份 id/账号名本地动态补全（只读本地、绝不联网/弹密码）。

**多类型预览（Phase 3 · P1）**
- 图片/视频缩略、音频片段、**PDF 首页**（落文件）；**文本/代码前 32KB、压缩包(zip/tar/tgz)文件列表**（`bz preview` 直接打印 stdout）。预览独立加密、云端零可见。

**分享**
- `bz share --code`（DEK 分享码）/ `--7z`（7z-AES 单包，第三方 7-Zip/Keka/p7zip 可解）。

### 安全
- 云端只见密文与随机 bundle 名；原文件名、大小、内容指纹都在**加密**的 encMeta 里。
- 内容指纹是**带密钥 HMAC**、仅存加密元数据——防确认攻击、跨账号不可关联。
- 任何解密路径 GCM 校验失败/错误口令**即报错**，绝不返回损坏数据。
- 凭证用户自备（`.env`）；代码无硬编码秘密。详见[安全模型](https://twisker.github.io/bizhou/zh/security.html)。

### 环境与安装
- 需 [Bun](https://bun.sh)（核心库兼容 Node LTS）；自备百度开放平台 AppKey/SecretKey。
- 当前从源码运行（`pnpm install` 后见文档站「快速开始」）；npm/Homebrew/Scoop 打包脚本已就绪，正式渠道随后。
- 可选预览工具：`ffmpeg`、`pdftoppm`（缺失时对应预览优雅跳过，不影响上传）。

### 已知事项 / 待联网人工验证
- 百度回收站**管理**接口可用性（当前 `trash` 对百度后端兜底提示去 App）。
- daemon 真机长跑、PowerShell 补全真机 tab、pdftoppm 真机抽帧——均为需真机环境的手动验证项，不影响自动化覆盖的核心逻辑。
- 尚未做：进 homebrew-core / winget（待用户量）；外部预览工具的 spawn 超时。

---

## English

### Highlights
Before your files reach Baidu Netdisk, they are **AES-256-GCM end-to-end encrypted locally** — the cloud only gets unreadable ciphertext; keys never leave your device. v1.0.0 is feature-complete with a green `bun test`.

### What's included

**Encryption core**
- AES-256-GCM envelope encryption; scrypt password derivation; master-key (MK) indirection (change password re-wraps only MK; forgotten password recovered via a recovery key); zero external crypto deps (built-in `crypto`).
- Logical chunking (default 100MB, adjustable), memory decoupled from file size; >4GB files round-trip byte-identical.

**Full CLI (`bz`)**
- Keys/session: `init` / `unlock` / `lock` / `passwd` / `recover`.
- Accounts: `login` / `logout` / `account` (multi-account, isolated spaces).
- Upload/download: `push` / `pull` with progress, `--chunk`/`--compress`/`--no-split`/`--name`.

**Cloud filesystem layer (v2)**
- Real directory trees (real folders both in the cloud and locally): `mkdir` / `ls -r` / `mv` / `cp -r` / `rename`.
- Deletions go to a **recycle bin** (`trash list/restore/rm/clear`).
- `-r` recursive whole-tree encrypted backup/restore; random cloud names + local real-name display; two configurable local roots (key root `~/.bizhou` + file root = Downloads dir).

**Robust upload (Phase 3 · S1)**
- **Concurrent** upload of 4MB slices within a chunk (`--concurrency`, default 4).
- **Resumable** (reuses the same DEK + uploaded chunks).
- **Content dedup + in-flight lock**: identical content already present/uploading is skipped — no duplicates.

**Robust download (Phase 3 · S2)**
- **Idempotent** (skip if identical content already at destination), **chunk-level resume**, temp file + **atomic landing**, **end-to-end contentId verification** (never delivers a half/corrupt file).

**Backup daemon (Phase 3 · D1)**
- `bz backup add/list/rm/run` register encrypted backup jobs; `bz daemon` runs a foreground daemon (initial sweep + live watch + periodic sweep); backup semantics **never delete from the cloud**.

**Shell completion (Phase 3 · C1)**
- `bz completion <bash|zsh|powershell>` — static completion of commands/subcommands/flags + local dynamic completion of backup ids/account names (local-only, never network/password prompt).

**Multi-type previews (Phase 3 · P1)**
- Image/video thumbnails, audio clips, **PDF first page** (written to a file); **first 32KB of text/code, archive (zip/tar/tgz) file listings** (printed to stdout by `bz preview`). Previews are separately encrypted, invisible to the cloud.

**Sharing**
- `bz share --code` (DEK share code) / `--7z` (a 7z-AES single package openable by any third party with 7-Zip/Keka/p7zip).

### Security
- The cloud sees only ciphertext and random bundle names; original filename, size, and content fingerprint live inside the **encrypted** encMeta.
- The content fingerprint is a **keyed HMAC** stored only in encrypted metadata — resists confirmation attacks, not correlatable across accounts.
- Any decryption path with a GCM failure / wrong password **errors out**, never returning corrupt data.
- Credentials are user-provided (`.env`); no hardcoded secrets. See the [security model](https://twisker.github.io/bizhou/en/security.html).

### Requirements & install
- Needs [Bun](https://bun.sh) (core lib is Node-LTS compatible); bring your own Baidu Open Platform AppKey/SecretKey.
- Runs from source today (`pnpm install`, then see the docs site "Quick start"); npm/Homebrew/Scoop packaging is ready, channels to follow.
- Optional preview tools: `ffmpeg`, `pdftoppm` (when missing, the corresponding preview is skipped gracefully; upload is unaffected).

### Known items / pending manual (live) verification
- Availability of Baidu's recycle-bin **management** API (currently `trash` falls back to a "use the app" hint for the Baidu backend).
- Daemon long-run on a real machine, PowerShell completion tab behavior, pdftoppm real thumbnailing — manual items needing a real environment; they don't affect the automated coverage of core logic.
- Not yet done: homebrew-core / winget submission (pending a user base); spawn timeouts for external preview tools.
