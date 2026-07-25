# 测试登记表

本文件记载 **敝帚（Bìzhǒu）** 各模块的测试覆盖情况、测试规范与测试场景。

---

## 当前测试结果（2026-07-25，v1.1.0 云端保险库）

- `bun test`：**303 项全绿 + 1 skip**（45 文件），`pnpm run typecheck` 双包通过，`biome check` 无 error。
- **v1.1.0 新增覆盖**：
  - `vault-cloud.test.ts`（core）：putCloudVault→fetchCloudVault 往返等价；换机语义（只凭云端 vault + 主密码解出同一 MK）；云端没有→null；**损坏/字段残缺→抛 VaultError 而非 null**（这条守着"老用户被误判为新用户 → init 铸新 MK → 数据永久锁死"的链路）；保险库与同名目录都不出现在 listDir；覆盖写；不透明命名不含产品名指纹。
  - `password-strength.test.ts`（core）：四词短语/混合 16 位达标；过短、空、单字符重复、常见弱口令基底、纯数字、含产品名一律不达标；熵估算随长度单调不减；理由不回显密码。
  - `recovery-export.test.ts`（core）：重导出得到**同一串**且真能解锁；改密后仍可导出；错 MK 拒绝；v1.0.x 老 vault（无 wrappedRecoveryByMk）导出抛错、可 rotate；**rotate 前先 verifyMk**（否则用错 MK 覆盖备用入口即永久废掉）；vault 内无明文恢复密钥。
  - `backend.baidu-trash.test.ts`（core，新增带目录语义的假网盘夹具 `helpers/fake-netdisk.ts`）：移入 .trash / 列出（含原路径与删除时间）/ 还原（父目录已删也能重建）/ 单条删 / 清空 / 空回收站不抛 / listDir 排除 .trash / entryId 穿越拒绝 / 不存在条目报错；回归防护：trashPath 不再发原生 opera=delete。
  - `quota.test.ts`（core）：total/used 正确；打到 /api/quota 且带 token；errno 与字段缺失一律抛错，**绝不返回 0**。
  - `vault-cloud-cmd.test.ts`（cli，`--local` 当云端）：init 后云端有且与本地一致；弱密码被拦下且不留半初始化状态；`--no-cloud-vault` 放行但只留本地；换机 unlock 自动取回并解出同一 MK；**云端损坏时 unlock 报错、绝不当新用户放行**；改密/恢复后云端同步更新；改密弱新密码被拒且云端不被改坏；vault sync 的强度/口令/未登录三条拒绝路径；unlock 顺带补传（弱密码则坚决不传）；vault status 无需主密码。
  - `vault-recovery-cmd.test.ts`（cli）：重导出的就是 init 那串；**会话已解锁也必须重输主密码**；老 vault 提示 --rotate；--rotate 后新密钥可解、旧的作废、本地与云端一起更新；口令错时不改动任何东西。
- **D1（daemon/定时备份）新增覆盖**：`backup-cmd.test.ts`（`bz backup add/list/rm` 端到端，非目录/未知任务失败路径）、`sweep.test.ts`（`sweepJob` 幂等 walk+`pushOneFile`：首轮上传→二轮全跳过→改动文件只重传改动项→源目录不存在时安全跳过不抛）、`watcher.test.ts`（`debounce`/`listDirsRecursive` 纯逻辑；`watchRecursive` 真实 fs.watch 事件触发 + `stop()` 后不再触发）、`serial-runner.test.ts`（`SerialJobRunner`：空闲 `trigger()` 立即跑一次；运行中的多次 `trigger()` 合并为一次补跑且 `maxConcurrent===1`）。`sweepJob`/`cmdBackup`/`SerialJobRunner` 均离线（内存后端/本地临时目录），不联网。
- **S1-T5 新增覆盖**（`packages/cli/test/push-idempotency.test.ts`，内存后端/内存 vault，不联网）：同内容第二次 push → `skipped-dup` 且不新增 bundle；`--force` 绕过去重仍上传（新增 bundle）；预置存活在飞锁（pid=当前进程）→ `locked` 且不上传；预置崩溃残留日志（stale pid + doneChunks=[0]）→ `resumed`，复用原 bundleId 且 `skipExisting` 令 seq 0 不再 `putChunk`。另手工验证（未入自动化套件）：分片中途抛错时 journal 保留且 `doneChunks` 只含已完成的分片（`onProgress`→`appendDoneChunk` 串行队列在 `packResource` 失败路径下仍正确落盘）。
- **v2-Phase 2 新增覆盖**：上传/下载映射纯函数（含 name basename 净化 + `..` 拒绝）、push 缺省镜像 / pull 落文件根、`push -r`/`pull -r` 整树往返字节一致、pull `--out` 恶意 meta.name 穿越被挡。
- **v2-Phase 3 新增覆盖**：filemanager move/copy/rename（mock）、Backend 目录级操作（本地 fs）、renameResource（改名后分片/wrappedKey 不变、pull 字节一致）、CLI mv/cp/rename 端到端 + rename newName 穿越拒绝。
- **v2-Phase 4 新增覆盖**：LocalBackend `.trash/` 回收站往返（trash→list→restore→clear，listDir 忽略 .trash）、CLI rm→回收站（目录需 --yes）+ trash 命令。（BaiduBackend 原「原生 delete + 管理方法抛『去 App』」已被 v1.1.0 的 .trash 方案取代，见上。）
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
| daemon（cmdBackup/sweepJob/SerialJobRunner） | `packages/cli/test/{backup-cmd,sweep,serial-runner}.test.ts` | >= 80% | — | ✅ 已实现（`cmdDaemon` 长跑循环+信号处理为手动/集成验证，不自动化） |
| watcher（debounce/listDirsRecursive/watchRecursive） | `packages/cli/test/watcher.test.ts` | >= 70% | — | ✅ 已实现（跨 OS 事件差异手动验证兜底） |

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
