# Sprint 计划

本文件记载 **敝帚（Bìzhǒu）** 计划经历的各个阶段（Sprint）及任务项。每个 Sprint 有整体目标与截止日期，任务详细拆分、指定优先级，并随开发进度持续更新状态。

> **责任人说明：** 标记为"人工"的任务需要人工介入处理，与根目录 `人工TODO事项.md` 双向同步。标记为"AI"的任务由 AI 独立完成。
> **里程碑映射：** Sprint 0 覆盖工程框架 + PRD 的 **M0（技术验证 Spike）**；Phase 1 覆盖 PRD 的 **M1（核心库 + CLI）**。
>
> **进度快照（2026-07-23）：M0 ✅ + M1 ✅ 功能全部完成。**
> - **M0 通过**：真实百度账号跑 `scripts/m0-verify.sh 500`，500MB 加密文件上传→下载字节级一致、云端未限制/封禁（全案前提成立）；上行 ≈5.5MB/s、下行 ≈1.1MB/s。
> - **M1 完成**：核心库 + CLI + 预览 + 7z + 多账号 + 构建/lint/打包，`bun test` 76 全绿，>4GB 本地实证。
> - 剩余仅**发布**（Homebrew/Scoop manifest 已就绪，需渠道账号 + GitHub Release，H-05）。详见 `.claude/current-sprint.md`。

---

## Sprint 0（项目初始化 + M0 技术验证）

**目标：** 搭好 pnpm monorepo 工程骨架（TS/lint/test/CI），并完成 PRD M0 关键验证——用一个百度开放平台应用凭证跑通 OAuth + 上传/下载往返字节一致，且确认云端不因"不可识别的加密大文件"而限制。

**截止：** 待定（M0 是全案前提，应尽早验证）

### 任务拆分

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | 申请/配置百度开放平台应用凭证（AppKey/SecretKey），创建 `/apps/bizhou/` 沙盒 | baidu / 外部 | 人工 | 待开始 |
| P0 | 初始化 pnpm monorepo：根 workspace、`packages/core`、`packages/cli`、tsconfig、Bun/Node 双兼容配置 | 工程 | AI | 待开始 |
| P0 | 配置 ESLint + Prettier/Biome + `bun test` + 类型检查脚本 | 工程 | AI | 待开始 |
| P0 | 配置 CI（push/PR：lint + 类型 + 测试 + 构建，三平台矩阵，不触真实网盘） | CI/CD | AI | 待开始 |
| P0 | M0-Spike：实现最小 OAuth2 授权码/device-code 流，拿到 access token | baidu | AI | 待开始 |
| P0 | M0-Spike：走通 precreate → superfile2（4MB 片）→ create，上传测试文件到 `/apps/bizhou/` | baidu | AI | 待开始 |
| P0 | M0-Spike：下载回来做 **SHA-256 字节级一致性**校验 | baidu | AI | 待开始 |
| P0 | **M0 关键验证**：上传"内容不可识别的加密大文件"，确认云端不因此限制/封禁 | baidu / 人工 | 人工 | 待开始 |
| P1 | M0-Spike：实测并记录 QPS / 配额 / 频率限制，据此定并发与退避策略 | baidu | 人工 | 待开始 |
| P1 | 建立版本钩子（VERSION + bump 脚本 + pre-commit）验证自动 patch 生效 | 工程 | AI | 已完成 |
| P1 | 撰写 LICENSE（Apache-2.0）与初版 README | 文档 | AI | 待开始 |

**验收（= PRD M0 验收）：** 一个文件能加密上传 + 下载还原，字节一致，且不被限制。

---

## Phase 1 — 核心库 + CLI（对应 PRD M1）

**目标：** 打通完整 pipeline（可选压缩→加密→分片→bundle→上传；下载→合并→解密→还原）；`bz` 全部命令可用；预览生成 + 7z-AES 导出 + 多账号切换；单元 + 集成测试齐备。

### Sprint 1（加密内核 + Bundle/Manifest）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | AES-256-GCM 信封加密：DEK 生成、内容加解密、GCM tag 校验 | crypto | AI | 待开始 |
| P0 | KDF（scrypt 首选/argon2id）：主密码派生 KEK、加盐、参数化 | crypto | AI | 待开始 |
| P0 | 信封：KEK 包裹/解包 DEK（wrappedKey）、恢复密钥生成与恢复流程 | crypto | AI | 待开始 |
| P0 | manifest.json schema（v1）读写 + 校验；encMeta（DEK 加密元数据） | bundle | AI | 待开始 |
| P0 | `.bz` bundle 目录结构：不透明 ID、分片命名、preview 指向 | bundle | AI | 待开始 |
| P0 | 加密链路**字节级往返一致性**单测 + KDF/tag 失败路径测试 | crypto/bundle | AI | 待开始 |

### Sprint 2（分片器 + 上传/下载对接）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | 逻辑分片器（默认 100MB，可配置）+ `worker_threads` 并行加密、流式不阻塞 | chunker | AI | 待开始 |
| P0 | 百度对接层：OAuth（授权码 + device-code）、token 刷新 | baidu | AI | 待开始 |
| P0 | 上传：precreate → superfile2（4MB 传输分片，`uploadid` 断点续传）→ create | baidu | AI | 待开始 |
| P0 | 下载：list bundle、读 manifest、下载分片/预览、合并还原 | baidu | AI | 待开始 |
| P1 | 并发/退避策略（依 M0 实测配额）、错误分类 | baidu | AI | 待开始 |
| P0 | 集成测试（mock/录制回放）+ >4GB 大文件往返字节一致 + 断点续传 | 测试 | AI | 待开始 |

### Sprint 3（CLI `bz` 命令集）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | `bz init` / `bz unlock`（主密码、恢复密钥、KEK 缓存进 OS 钥匙串） | cli / keystore | AI | 待开始 |
| P0 | `bz login` / `bz logout`（浏览器 + 本地回调 / device-code） | cli / baidu | AI | 待开始 |
| P0 | `bz push` / `bz pull`（加密上传 / 下载还原，进度条、`--chunk`/`--compress`/`--no-split`/`--out`） | cli | AI | 待开始 |
| P1 | `bz ls` / `bz info` / `bz rm`（读 manifest 显示真名、元数据、删除） | cli | AI | 待开始 |
| P1 | 隐藏口令输入、退出码规范、彩色输出、`--verbose` | cli / render | AI | 待开始 |

### Sprint 4（预览 + 分享 + 多账号 + 分发）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P1 | 预览包生成（视频抽帧/音频截段/图片缩略）+ 独立加密 + `bz preview` | preview / cli | AI | 待开始 |
| P1 | 分享：`bz share --code`（导出资源 DEK 分享码，可失效）| export / cli | AI | 待开始 |
| P1 | 分享：`bz share --7z`（7z-AES + 头部加密导出，第三方可解） | export / cli | AI | 待开始 |
| P1 | 多账号：`bz account list/use/add`，每账号独立 token 与 `/apps/bizhou/` 空间 | account / cli | AI | 待开始 |
| P1 | `bz` 可作为 agent Skill 被调用（打包/清单） | cli | AI | 待开始 |
| P2 | 发版流水线：npm publish `@bizhou/core` + Homebrew tap + Scoop bucket manifest | CI/CD | AI | 待开始 |

**验收（= PRD M1 验收）：**
- >4GB 大文件分片上传 + 还原字节一致；断点续传可用。
- 导出的 7z-AES 包能被第三方 7-Zip / Keka / p7zip + 密码解密。
- CLI 可作为 Skill 被 agent 调用。

---

## Phase 2 — 打磨与生态（待细化）

> Sprint 拆分待 Phase 1 完成后细化。候选：shell 补全、更多预览类型、daemon/定时备份、GUI 前端接入核心库、进 homebrew-core / winget、移动端（远期）。
