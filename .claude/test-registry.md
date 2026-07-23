# 测试登记表

本文件记载 **敝帚（Bìzhǒu）** 各模块的测试覆盖情况、测试规范与测试场景。

---

## 当前测试结果（2026-07-23）

- `bun test`：**131 项全绿 + 1 skip**（15 文件），`pnpm run typecheck` 双包通过，`biome check` 无 error，`pnpm run build` 产 3 份产物。
- **v2-Phase 2 新增覆盖**：上传/下载映射纯函数（含 name basename 净化 + `..` 拒绝）、push 缺省镜像 / pull 落文件根、`push -r`/`pull -r` 整树往返字节一致、pull `--out` 恶意 meta.name 穿越被挡。
- **v2-Phase 3 新增覆盖**：filemanager move/copy/rename（mock）、Backend 目录级操作（本地 fs）、renameResource（改名后分片/wrappedKey 不变、pull 字节一致）、CLI mv/cp/rename 端到端 + rename newName 穿越拒绝。
- **v2-Phase 4 新增覆盖**：LocalBackend `.trash/` 回收站往返（trash→list→restore→clear，listDir 忽略 .trash）、BaiduBackend 原生 delete + 管理方法抛"去 App"、CLI rm→回收站（目录需 --yes）+ trash 命令。
- 测试文件：core `{crypto,base32,vault,bundle,resource,baidu,account,preview,baidu.live,config,cloudpath,backend.local,backend.baidu}.test.ts` + cli `{cli,fs}.test.ts`（baidu.live 需 `BIZHOU_LIVE=1`+token，默认 skip；cli.test 的 7z 测试无 7z 时 skip）。
- **v2-Phase 1 新增覆盖**：config 双根解析、cloudpath 纯函数（含 `..` 拒绝防穿越）、Backend/LocalBackend/BaiduBackend（mkdir/listDir/bundleStore）、CLI `bz mkdir`/`ls -r`/`push --to` 离线端到端。
- 关键覆盖：AES-GCM 往返 + 篡改/错密钥/AAD 失败、KDF/信封、vault 双路解锁 + 改密、manifest 严格校验、**资源 pack→unpack 字节级往返**（单/多片/整除/空/gzip/3MB/内存 store）、篡改分片与错 MK 被拒、百度上传编排（partseq/md5/断点续传/errno）+ 模拟网盘端到端、多账号 + 设备密钥加密落盘、预览加密往返。
- 端到端实测（真实 `bz` 二进制，离线 `--local`）：push→pull 字节级一致、篡改被拒、错主密码被拒、ffmpeg 预览生成→加密→还原为有效 JPEG。
- **>4GB 实测**：4.29 GiB 文件 → 44 个 100MB 逻辑分片 → 还原 **SHA-256 字节级一致**（push 6s / pull 7s）。证明"逻辑分片规避云端 4GB 单文件上限"成立；每分片 ≤100MB。
- **第三方 7z 解密**：条件测试（`packages/cli/test/cli.test.ts`），有 7z 二进制时自动运行——用第三方 7z 以密码提取头部加密包并校验字节一致 + 错密码被拒；无 7z 则跳过（CI/装了 p7zip 的机器会执行）。
- 未自动化（需真实百度联网/账号）：M0 联网往返 + QPS 实测（已封装为 `scripts/m0-verify.sh` 一条命令）、真实云端断点续传。

---

## 通用测试规范

| 规范 | 要求 |
|------|------|
| 单元测试覆盖率 | 核心加密/bundle 逻辑 >= 85%；其他核心逻辑 >= 80% |
| 往返一致性 | 上传→下载→解密→合并**字节级一致**（SHA-256），作为硬性回归测试 |
| 失败路径 | GCM tag 篡改、错误主密码、损坏 manifest、错误恢复密钥必须被检测并报错，绝不静默返回损坏数据 |
| 百度接口测试 | 用 mock / 录制回放，CI 中不依赖真实网盘；真实往返仅在人工 RC 冒烟执行 |
| CLI 测试 | 命令级集成测试（退出码、参数解析、错误消息）；口令输入不回显/不入日志的断言 |
| 大文件测试 | >4GB 分片上传 + 断点续传 + 还原字节一致（可用生成的稀疏/伪随机大文件） |
| 测试运行器 | `bun test`（Bun 优先）；核心库须在 Node LTS 下亦可通过 |
| 性能 | 内存占用与文件大小解耦（chunk-at-a-time 流式，一次只驻留一片）；worker_threads 并行为后续优化 |

---

## 核心库测试覆盖（`@bizhou/core`）

| 模块 | 测试文件 | 覆盖率要求 | 当前覆盖率 | 状态 |
|------|---------|-----------|-----------|------|
| crypto（AES-GCM/KDF/信封/恢复密钥） | `packages/core/test/crypto.*` | >= 85% | — | ✅ 已实现 |
| bundle（manifest/encMeta/.bz 结构） | `packages/core/test/bundle.*` | >= 85% | — | ✅ 已实现 |
| chunker（分片/流式往返） | `packages/core/test/resource.*` | >= 80% | — | ✅ 已实现 |
| baidu（OAuth/上传/下载/续传，mock） | `packages/core/test/baidu.*` | >= 80% | — | ✅ 已实现 |
| preview（预览生成 + 加密） | `packages/core/test/preview.*` | >= 70% | — | ✅ 已实现 |
| export（7z-AES 导出） | `packages/core/test/export.*` | >= 70% | — | ✅ 已实现 |
| account / keystore | `packages/core/test/account.*` | >= 70% | — | ✅ 已实现 |

---

## CLI 测试覆盖（`bz`）

| 模块 | 测试文件 | 覆盖率要求 | 当前覆盖率 | 状态 |
|------|---------|-----------|-----------|------|
| commands（init/unlock/login/push/pull/…） | `packages/cli/test/commands.*` | >= 70% | — | ✅ 已实现 |
| prompt（隐藏口令、不回显） | `packages/cli/test/prompt.*` | >= 70% | — | ✅ 已实现 |

---

## 基础设施与部署测试覆盖

| 模块 | 测试文件 | 覆盖要求 | 状态 |
|------|---------|---------|------|
| CI 流水线 | `.github/workflows/` | 三平台全流程冒烟（lint+类型+测试+构建） | ✅ 已实现 |
| 发版流水线 | `scripts/` | npm publish 与 Homebrew/Scoop manifest 生成冒烟 | ✅ 已实现 |
| 版本钩子 | — | commit 后 patch 自动递增验证 | ✅ 已实现 |

---

## 测试场景登记

> 待各 Sprint 开发启动后逐步填充。M0 关键场景先行登记：

| Sprint | 目标模块 | 测试描述 | 测试文件 | 结果 |
|--------|---------|---------|---------|------|
| 0 (M0) | baidu | OAuth 拿 token → precreate/superfile2/create 上传 → 下载 → SHA-256 字节一致 | `scripts/m0-verify.sh` | ✅ 通过（2026-07-23，500MB） |
| 0 (M0) | baidu | 上传"不可识别的加密大文件"确认不被云端限制/封禁 | 人工验证 | ✅ 通过（未触发限制/封禁） |
| 0 (M0) | baidu | 实测 QPS/配额/限流阈值 | 人工验证 | ✅ 上行≈5.5MB/s、下行≈1.1MB/s，无限流（tech-spec §5） |
