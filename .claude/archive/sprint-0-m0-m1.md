# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：Sprint 0（初始化 + M0）→ Phase 1（M1）核心已完成

**最后更新：** 2026-07-23
**当前目标：** 离线可验证的加密引擎 + CLI 已全部打通并测试通过；剩余为**需真实百度联网**的 M0 验证与少量增强。

### 已完成（AI 自主推进，字节级往返一致性已证）

| 模块 | 说明 | 源码 | 状态 |
|------|------|------|------|
| crypto | AES-256-GCM 信封、scrypt KDF(NFKC)、wrap/unwrap、base32 | `packages/core/src/crypto/` | ✅ 稳定 |
| vault | MK 主密钥 + 主密码/恢复密钥双路解锁 + 改密 | `packages/core/src/vault/` | ✅ 稳定 |
| bundle | manifest v1、encMeta、不透明 ID、严格校验 | `packages/core/src/bundle/` | ✅ 稳定 |
| chunker | 分片(可选 gzip)加密/还原、AAD 绑定、内存与文件大小解耦 | `packages/core/src/chunker/` | ✅ 稳定 |
| store | BundleStore 抽象 + Local/Memory 实现 | `packages/core/src/store/` | ✅ 稳定 |
| resource | packResource/unpackResource/openPreview 编排 | `packages/core/src/resource/` | ✅ 稳定 |
| baidu | OAuth2 + precreate/superfile2/create/list/download + BaiduBundleStore | `packages/core/src/baidu/` | ✅ 代码完成（联网待验） |
| account/keystore/config | 多账号、设备密钥加密 SecretStore、配置目录 | `packages/core/src/{account,keystore,config}/` | ✅ 稳定 |
| CLI `bz` | init/unlock/lock/passwd/recover/login/logout/account/push/pull/ls/info/rm/share/preview | `packages/cli/src/` | ✅ 稳定（离线实测） |
| preview | ffmpeg 图片/视频缩略、音频片段 → DEK 加密 | `packages/cli/src/preview.ts` | ✅ 实测 |
| export7z | 头部加密 7z-AES 导出（需 7z 二进制） | `packages/cli/src/export7z.ts` | ✅ 代码完成（本机无 7z） |
| CI | 三平台 typecheck + bun test | `.github/workflows/ci.yml` | ✅ |

**测试：** `bun test` 73 项全绿；`pnpm run typecheck` 双包通过。CLI 端到端实测：push→pull 字节级一致、篡改分片被拒、错主密码被拒、ffmpeg 预览往返有效 JPEG。

### M0 已闭合 ✅（2026-07-23 真实百度往返通过）

- 500MB 加密文件真实上传→下载→**字节级一致**；**云端未限制/封禁** → 全案前提成立。
- 实测吞吐：上行 ≈5.5MB/s、下行 ≈1.1MB/s（免费账号 dlink 限速）；无限流/重试触发。详见 `tech-spec §5`。

### 待办

| 优先级 | 任务 | 责任人 | 状态 |
|-------|------|--------|------|
| — | M0 关键验证（真实往返 + 云端不限制） | 人工（H-02） | ✅ 已完成 |
| — | 吞吐实测（上/下行已测并记录） | 人工（H-03） | ✅ 基本完成（如需更精确配额可后续压测） |
| — | >4GB 分片 + 还原字节一致 | AI | ✅ 本地已证（4.29GiB→44 片） |
| P2 | 发布：生成 Homebrew/Scoop manifest（已就绪）+ npm publish + 传 GitHub Release（需渠道账号 H-05） | AI+人工 | 产物就绪，待人工发布 |

### 近期重要改动记录

| 时间 | 改动目的 | 涉及模块 |
|------|---------|---------|
| 2026-07-23 | 搭 monorepo + crypto 内核（信封/KDF/wrap）58 测试 | crypto/errors |
| 2026-07-23 | vault 主密钥架构 + base32 恢复密钥 | vault |
| 2026-07-23 | bundle/manifest v1 + encMeta + 严格校验 | bundle |
| 2026-07-23 | 分片器 + 资源编排：完整加密往返（字节级一致） | chunker/store/resource |
| 2026-07-23 | 百度 OAuth + 文件 API + BaiduBundleStore（mock 测试） | baidu |
| 2026-07-23 | 配置/设备密钥 SecretStore/多账号 | config/keystore/account |
| 2026-07-23 | CLI bz 全命令 + 端到端实测 | packages/cli |
| 2026-07-23 | ffmpeg 预览 + 7z-AES 导出 | cli/preview,export7z |
| 2026-07-23 | 三平台 CI + agent Skill | .github, cli/skill |

### 活跃文件清单

> 当前无进行中的半成品改动；已提交至 feature/init_proj。
