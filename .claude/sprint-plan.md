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
| P0 | 申请/配置百度开放平台应用凭证（AppKey/SecretKey），创建 `/apps/bizhou/` 沙盒 | baidu / 外部 | 人工 | ✅ 已完成 |
| P0 | 初始化 pnpm monorepo：根 workspace、`packages/core`、`packages/cli`、tsconfig、Bun/Node 双兼容配置 | 工程 | AI | ✅ 已完成 |
| P0 | 配置 ESLint + Prettier/Biome + `bun test` + 类型检查脚本 | 工程 | AI | ✅ 已完成 |
| P0 | 配置 CI（push/PR：lint + 类型 + 测试 + 构建，三平台矩阵，不触真实网盘） | CI/CD | AI | ✅ 已完成 |
| P0 | M0-Spike：实现最小 OAuth2 授权码/device-code 流，拿到 access token | baidu | AI | ✅ 已完成 |
| P0 | M0-Spike：走通 precreate → superfile2（4MB 片）→ create，上传测试文件到 `/apps/bizhou/` | baidu | AI | ✅ 已完成 |
| P0 | M0-Spike：下载回来做 **SHA-256 字节级一致性**校验 | baidu | AI | ✅ 已完成 |
| P0 | **M0 关键验证**：上传"内容不可识别的加密大文件"，确认云端不因此限制/封禁 | baidu / 人工 | 人工 | ✅ 已完成 |
| P1 | M0-Spike：实测并记录 QPS / 配额 / 频率限制，据此定并发与退避策略 | baidu | 人工 | ✅ 已完成 |
| P1 | 建立版本钩子（VERSION + bump 脚本 + pre-commit）验证自动 patch 生效 | 工程 | AI | 已完成 |
| P1 | 撰写 LICENSE（Apache-2.0）与初版 README | 文档 | AI | ✅ 已完成 |

**验收（= PRD M0 验收）：** 一个文件能加密上传 + 下载还原，字节一致，且不被限制。

---

## Phase 1 — 核心库 + CLI（对应 PRD M1）

**目标：** 打通完整 pipeline（可选压缩→加密→分片→bundle→上传；下载→合并→解密→还原）；`bz` 全部命令可用；预览生成 + 7z-AES 导出 + 多账号切换；单元 + 集成测试齐备。

### Sprint 1（加密内核 + Bundle/Manifest）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | AES-256-GCM 信封加密：DEK 生成、内容加解密、GCM tag 校验 | crypto | AI | ✅ 已完成 |
| P0 | KDF（scrypt 首选/argon2id）：主密码派生 KEK、加盐、参数化 | crypto | AI | ✅ 已完成 |
| P0 | 信封：KEK 包裹/解包 DEK（wrappedKey）、恢复密钥生成与恢复流程 | crypto | AI | ✅ 已完成 |
| P0 | manifest.json schema（v1）读写 + 校验；encMeta（DEK 加密元数据） | bundle | AI | ✅ 已完成 |
| P0 | `.bz` bundle 目录结构：不透明 ID、分片命名、preview 指向 | bundle | AI | ✅ 已完成 |
| P0 | 加密链路**字节级往返一致性**单测 + KDF/tag 失败路径测试 | crypto/bundle | AI | ✅ 已完成 |

### Sprint 2（分片器 + 上传/下载对接）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | 逻辑分片器（默认 100MB，可配置）+ 流式不阻塞（内存与文件大小解耦） | chunker | AI | ✅ 已完成（worker_threads 并行为后续优化，**未实现**） |
| P0 | 百度对接层：OAuth（授权码 + device-code）、token 刷新 | baidu | AI | ✅ 已完成 |
| P0 | 上传：precreate → superfile2（4MB 传输分片，`uploadid` 断点续传）→ create | baidu | AI | ✅ 已完成 |
| P0 | 下载：list bundle、读 manifest、下载分片/预览、合并还原 | baidu | AI | ✅ 已完成 |
| P1 | 并发/退避策略（依 M0 实测配额）、错误分类 | baidu | AI | ✅ 已完成 |
| P0 | 集成测试（mock/录制回放）+ >4GB 大文件往返字节一致 + 断点续传 | 测试 | AI | ✅ 已完成 |

### Sprint 3（CLI `bz` 命令集）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P0 | `bz init` / `bz unlock`（主密码、恢复密钥、KEK 缓存进 OS 钥匙串） | cli / keystore | AI | ✅ 已完成 |
| P0 | `bz login` / `bz logout`（浏览器 + 本地回调 / device-code） | cli / baidu | AI | ✅ 已完成 |
| P0 | `bz push` / `bz pull`（加密上传 / 下载还原，进度条、`--chunk`/`--compress`/`--no-split`/`--out`） | cli | AI | ✅ 已完成 |
| P1 | `bz ls` / `bz info` / `bz rm`（读 manifest 显示真名、元数据、删除） | cli | AI | ✅ 已完成 |
| P1 | 隐藏口令输入、退出码规范、彩色输出、`--verbose` | cli / render | AI | ✅ 已完成 |

### Sprint 4（预览 + 分享 + 多账号 + 分发）

| 优先级 | 任务 | 所属模块 | 责任人 | 状态 |
|-------|------|----------|--------|------|
| P1 | 预览包生成（视频抽帧/音频截段/图片缩略）+ 独立加密 + `bz preview` | preview / cli | AI | ✅ 已完成 |
| P1 | 分享：`bz share --code`（导出资源 DEK 分享码，可失效）| export / cli | AI | ✅ 已完成 |
| P1 | 分享：`bz share --7z`（7z-AES + 头部加密导出，第三方可解） | export / cli | AI | ✅ 已完成 |
| P1 | 多账号：`bz account list/use/add`，每账号独立 token 与 `/apps/bizhou/` 空间 | account / cli | AI | ✅ 已完成 |
| P1 | `bz` 可作为 agent Skill 被调用（打包/清单） | cli | AI | ✅ 已完成 |
| P2 | 发版流水线：npm publish `@bizhou/core` + Homebrew tap + Scoop bucket manifest | CI/CD | AI | ⏳ 部分（`scripts/gen-packaging.sh` 生成 tarball+manifest 就绪；实际 publish/GitHub Release **待渠道账号 H-05**） |

**验收（= PRD M1 验收）：**
- >4GB 大文件分片上传 + 还原字节一致；断点续传可用。
- 导出的 7z-AES 包能被第三方 7-Zip / Keka / p7zip + 密码解密。
- CLI 可作为 Skill 被 agent 调用。

---

## v2 — 云端文件系统层（M1 之后的新特性）

**目标：** 把"单文件加密"升级为"整个文件夹的加密云备份/还原 + 类文件系统管理"：真实目录树、双可配本地根（密钥根 `~/.bizhou` + 文件根=下载目录）、上传/下载映射、`mv/cp/rename`、原生回收站、`-r` 递归整树。

**设计（已确认）：** `docs/superpowers/specs/2026-07-23-cloud-filesystem-layer-design.md`
**执行方式：** 子代理驱动（superpowers:subagent-driven-development），逐任务 TDD，完成后交人工按 git flow 发版。

### v2-Phase 1 — 双本地根 + 目录树基础 ✅ **完成（2026-07-23）**
> 计划：`docs/superpowers/plans/2026-07-23-cloud-fs-phase1-roots-and-tree.md`；归档：`.claude/archive/v2-phase1-cloud-fs.md`

| 任务 | 说明 | 所属模块 | 责任人 | 状态 |
|-----|------|---------|--------|------|
| T1 | 双本地根解析（密钥根/文件根，可配） | core/config | AI | ✅ 已完成 |
| T2 | cloudpath 云端路径纯函数（含 `..`/`\` 拒绝防穿越） | core/cloudpath | AI | ✅ 已完成 |
| T3 | BaiduClient.mkdir + BaiduBundleStore cloudDir | core/baidu | AI | ✅ 已完成 |
| T4 | Backend 抽象 + LocalBackend | core/backend | AI | ✅ 已完成 |
| T5 | BaiduBackend + 导出 | core/backend | AI | ✅ 已完成 |
| T6 | CLI runtime keyRoot/fileRoot + makeBackend | cli/runtime | AI | ✅ 已完成 |
| T7 | `bz mkdir` / `bz ls -r` / `push --to` | cli/commands | AI | ✅ 已完成 |
| T8 | 登记表同步 + 阶段收尾 | 文档 | AI | ✅ 已完成 |
| T9 | 递归 bundle 解析（Phase 2 前移，子目录资源可按 id/前缀取回） | cli | AI | ✅ 已完成 |

**验收：** `bun test` 96 全绿 + 1 skip；typecheck/lint/build(3) 全过；opus 整分支评审 ✅ Ready to merge；评审修复路径穿越（`..`/`\`）+ cmdPreview 隐患。

### v2-Phase 2 — 上传/下载映射（含 `-r` 整树备份/还原）✅ **完成（2026-07-23）**
> 计划：`docs/superpowers/plans/2026-07-23-cloud-fs-phase2-mapping-recursive.md`

| 任务 | 说明 | 状态 |
|-----|------|------|
| T1 | cloudpath 映射纯函数（defaultUploadCloudDir/downloadLocalPath，含 name basename 净化） | ✅ |
| T2 | push 缺省云端目录镜像 + pull 落文件根带入结构（含 --out 穿越修复） | ✅ |
| T3+T4 | `push -r` / `pull -r` 递归整树加密备份/还原 | ✅ |
| — | 路径→bundle 递归解析（已在 v2-P1 T9 前移完成） | ✅ |

**验收：** `bun test` 105 全绿 + 1 skip；typecheck/lint/build 全过；每任务子代理实现+评审，修复 2 处路径穿越（--out `meta.name`、name 未净化）。

### v2-Phase 3 — 文件操作 ✅ **完成（2026-07-23）**
> 计划：`docs/superpowers/plans/2026-07-23-cloud-fs-phase3-file-ops.md`

| 任务 | 说明 | 状态 |
|-----|------|------|
| T1 | filemanager move/copy/rename + Backend 目录级 move/copy/rename（含 rename newName 单段校验防穿越） | ✅ |
| T2 | `renameResource`（bundle 真名=重写 encMeta，分片不动） | ✅ |
| T3 | `bz mv` / `cp`(`-r`) / `rename`（目录 native / bundle encMeta；分派只对"未找到"回退目录） | ✅ |

**验收：** `bun test` 122 全绿 + 1 skip；typecheck/lint/build 全过；修复 2 处 Important（rename 穿越、分派吞错）。

### v2-Phase 4 — 回收站 ✅ **完成（2026-07-23）**
> 计划：`docs/superpowers/plans/2026-07-23-cloud-fs-phase4-recycle-bin.md`

| 任务 | 说明 | 状态 |
|-----|------|------|
| T1 | Backend 回收站：LocalBackend `.trash/`（完整可测）+ BaiduBackend 原生删除/管理提示去 App | ✅ |
| T2 | `bz rm`→回收站（目录需 `--yes`）+ `bz trash [list/restore/rm/clear]` | ✅ |

**验收：** `bun test` 131 全绿 + 1 skip；typecheck/lint/build 全过；修复 rename 穿越/分派吞错等（见各阶段）。
**⚠ 待联网验证（人工 H-08）：** 百度开放平台**回收站管理接口**是否可用——当前 `bz trash *` 对百度后端抛"请到百度 App 操作"兜底；若开放 API 实际支持，可后续接入。删除进原生回收站本身可用（filemanager delete）。

---

## Phase 3 — 打磨与生态

> **范围：本项目只做 CLI 相关（不做 GUI 前端、不做移动端）。**
> 候选池：shell 补全、更多预览类型、daemon/定时备份、进 homebrew-core / winget、worker_threads 并行加密。
> **子项各自 spec→plan→执行。已澄清并定型的子项在下方按 Sprint 拆分。**

### Phase 3 · S1 — 健壮上传（并发 + 续传 + 幂等） ✅ **完成（2026-07-23）**

> 设计：`docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`
> 计划：`docs/superpowers/plans/2026-07-23-robust-upload-s1.md`（含各任务完整 TDD 步骤与代码）
> 来源：候选「worker_threads 并行加密/上传」经澄清——真正杠杆是**上传并发（async I/O，不引 worker_threads）**，并顺带补齐续传接线与内容级幂等。

**目标：** `bz push` 具备片内 4MB 并发上传、中断续传、内容级幂等（去重跳过 + 在飞锁），manifest 本地缓存消除去重扫描的重复网络拉取。

**执行方式：** 子代理驱动开发（每任务 实现子代理 TDD + 评审子代理），完成后整分支评审，交人工按 git flow 合并。

| 任务 | 说明 | 责任人 | 状态 |
|-----|------|--------|------|
| S1-T1 | `contentId` 内容身份底座：HKDF(MK) 派生 + HMAC(明文)，存加密 encMeta；`ResourceMeta`/`PackOptions` 接线；`info` 显示 | AI | ✅ 已完成 |
| S1-T2 | `uploadPart` 4MB 分片限流池并发（默认 4，clamp[1,16]）+ AbortController fail-fast；`withRetry`/`uploadSlice` 支持 signal | AI | ✅ 已完成 |
| S1-T3 | 上传日志模块（`journal/`）：一份 JSON 兼作 在飞锁 + 续传状态；核心不读时钟（now/pid 注入） | AI | ✅ 已完成 |
| S1-T4 | manifest 缓存模块（`cache/`，只存加密态）+ `rename`/`rm`/`trash` 失效钩子 | AI | ✅ 已完成 |
| S1-T5 | `cmdPush` 集成：预哈希→去重（走缓存）→锁/续传→`--force`/`--concurrency`→消息；抽出共用 `pushOneFile` | AI | ✅ 已完成（2026-07-23） |
| S1-T6 | `push -r` 递归复用 `pushOneFile`，整树去重/续传/锁一致 | AI | ✅ 已完成 |

**验收（达成）：** `bun test` **155 全绿 + 1 skip**；typecheck/lint/build(3) 全过。每任务子代理实现 + 评审，opus 整分支最终评审 **✅ Ready to merge**。
**评审拦下的关键缺陷（均已修 + 补测）：**
- **2 个 Critical crypto（T5）：** ①resume 重新生成 DEK → 续传出的 bundle 永不可解（修：journal 存 MK 包裹的 DEK，续传复用）；②确定性 chunk-IV 未固定 chunkSize/compression → 换 `--chunk`/`--compress` 续传即 **AES-GCM nonce 复用**（修：journal 固定 chunkSize+compression，续传强制沿用；tech-spec §5.1.1 记录 IV 方案与唯一性不变式）。
- **Important：** journal 全字段形状校验（T3）；首推新云端目录 `listDir` 先于 `mkdir` → 百度后端抛错（T6/F1，修：`pushOneFile` 先 mkdir 再去重扫描 + strict-listDir 回归测试）。
**安全红线自检通过：** contentId 仅入加密 encMeta（云端零泄露）；journal/cache 无明文密钥（journal 存 MK 包裹 DEK）；缓存键 `assertNameSegment` 防穿越、且 bundleId 不可变 → 陈旧缓存永不致错误去重；GCM 失败即抛不静默。
**新增模块/测试：** `@bizhou/core` → `content`/`journal`/`cache`；测试 `content`/`journal`/`cache`/`upload-concurrency`/`push-idempotency`/`push-recursive-idempotency` + 内存后端夹具。

### Phase 3 · S2 — 健壮下载（幂等 + 在飞锁 + 分片续传 + 原子落地） ✅ **完成（2026-07-24）**

> 设计：`docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`（S2 段）
> 计划：`docs/superpowers/plans/2026-07-23-robust-download-s2.md`（含各任务完整 TDD 步骤与代码）
> 复用 S1 的 `content`/`journal`/`cache` 底座。执行方式：子代理驱动（同 S1）。

| 任务 | 说明 | 责任人 | 状态 |
|-----|------|--------|------|
| S2-T1 | 核心续传：`decryptChunksToFile` 支持 `skip`（定位写入 + 收尾 truncate）+ `UnpackOptions.skip` 透传；`journal` 上传专属字段（wrappedKey/chunkSize/compression）改可选（下载复用） | AI | ✅ 已完成 |
| S2-T2 | `cmdPull` 集成：幂等（目标 hash==contentId 跳过）→在飞锁→解密到 `.part`→**端到端 contentId 校验**→原子改名落地→`--force`；抽出共用 `pullOneBundle` | AI | ✅ 已完成 |
| S2-T3 | `pull -r` 递归复用 `pullOneBundle`，整树幂等/续传/锁一致 | AI | ✅ 已完成 |

**验收目标：** 下载往返字节一致；幂等跳过/在飞锁/分片续传/端到端校验各有集成测试；`bun test` 全量无回归；typecheck/lint/build 全过。**续传正确性双保险：** 逐片密文 sha256（下载即校验）+ 装配后端到端 contentId（防日志/flush 竞态跳过实际缺失片）；无 contentId 的旧 bundle 退化为仅前者。**红线：** 端到端校验不过绝不 rename 交付、绝不静默写损坏。

### Phase 3 · D1 — daemon / 定时备份 ✅ **完成（2026-07-24，待人工 git flow 合并）**

> 设计：`docs/superpowers/specs/2026-07-24-daemon-scheduled-backup-design.md`
> 计划：`docs/superpowers/plans/2026-07-24-daemon-scheduled-backup-d1.md`（含各任务完整 TDD 步骤）
> 复用 S1 `pushOneFile`（去重/续传/在飞锁兜底）。执行方式：子代理驱动。

| 任务 | 说明 | 责任人 | 状态 |
|-----|------|--------|------|
| D1-T1 | 核心备份任务模型 + `backups.json` 持久化（add/list/rm/update，原子，无密钥） | AI | ✅ 已完成 |
| D1-T2 | CLI `bz backup add/list/rm` 命令（新 `daemon.ts`，单向依赖 commands.ts） | AI | ✅ 已完成 |
| D1-T3 | `sweepJob` 幂等备份引擎（walk + pushOneFile + 单文件错误隔离）+ `bz backup run` | AI | ✅ 已完成 |
| D1-T4 | 跨平台递归 watcher + 防抖（debounce/listDirsRecursive 可测；fs.watch 薄壳手动验证） | AI | ✅ 已完成 |
| D1-T5 | `bz daemon` 三触发编排 + `SerialJobRunner` 串行护栏 + 优雅退出 + config 间隔/防抖 | AI | ✅ 已完成 |

**范围/语义：** 注册式备份任务；三触发（启动即扫 / 实时监听防抖 / 定时兜底）共用幂等 `sweepJob`；**备份语义永不删云**（本地删不镜像）；前台进程、SIGINT/SIGTERM 优雅退出；MK 驻内存至退出。**测试边界：** 模型/引擎/防抖/串行护栏纯逻辑自动化覆盖；`fs.watch` OS 事件与完整 daemon 长跑 = 手动/集成验证（待人工真机验证 H-09）。**红线：** daemon 不打印密钥；加密全复用 S1；零新依赖。

**验收（达成）：** `bun test` **181 全绿 + 1 skip**；typecheck/lint/build(3) 全过。opus 整分支最终评审 **✅ Ready to merge**（安全红线全过：不打印密钥、MK 全退出路径 `finally` 抹除、永不删云；镜像路径与 `push -r` 逐字一致；跨进程靠 S1 在飞锁防重传）。
**评审拦下并修复的 Important（各任务）：** ①`readBackups` 读失败吞错→会截断任务注册（改：ENOENT/损坏→[]，其它 IO 错误→抛）+ 唯一 tmp 防并发写 clobber（T1）②`watchRecursive.stop()` 与异步注册竞态→泄漏 FSWatcher/卡退出（改：`stopped` 守卫）（T4）③`SerialJobRunner` run() 抛错→丢合并补跑 & `drain()` reject 致退出挂死（改：loop 吞逃逸异常）+ daemon `try/finally` 抹 MK + `once` 信号 + drain `.catch`（T5）。
**已知限制（defer）：** `bz backup add` 与运行中 daemon 的 `updateLastBackup` 对 `backups.json` 有 last-writer-wins 竞态，极端下新加任务可能被覆盖——单用户工具、`backup list` 可见、重跑 add 即修复；不损云端数据。id 为 32-bit 随机（个人规模碰撞可忽略）；空源目录不建空云端镜像目录。

### Phase 3 · C1 — shell 补全 ✅ **完成（2026-07-24）**

> 设计：`docs/superpowers/specs/2026-07-24-shell-completion-design.md`
> 计划：`docs/superpowers/plans/2026-07-24-shell-completion-c1.md`（含各任务完整 TDD 步骤）
> 范围：bash / zsh / PowerShell（不含 fish）；静态 + 本地动态（backup-id/account/shell），云端动态缓做。执行方式：子代理驱动。

| 任务 | 说明 | 责任人 | 状态 |
|-----|------|--------|------|
| C1-T1 | 命令规格表（类型 + GLOBAL_FLAGS + COMMANDS，单一真值来源）+ 与 index.ts 命令集一致性测试 | AI | ✅ 已完成 |
| C1-T2 | `bz __complete`（本地动态 backup-id/account/shell，**零联网零解锁**，出错静默空）+ 隐藏分发 | AI | ✅ 已完成 |
| C1-T3 | 三 shell 生成器（genBash/genZsh/genPowerShell 纯函数，规格表→脚本）+ 生成器测试 | AI | ✅ 已完成 |
| C1-T4 | `bz completion <shell>` 命令 + `index.ts` 分发 + HELP | AI | ✅ 已完成 |

**验收（达成）：** `bun test` **204 全绿 + 1 skip**；typecheck/lint/build 全过。opus 整分支最终评审 **✅ Ready to merge**（安全红线全过：`__complete` 只读本地、绝不 resolveMk/网络/弹密码、出错静默、脚本与输出零密钥）。
**评审拦下并修复的关键缺陷：** ①`genZsh` 两个 **Critical**——自屏蔽 `words` + 子命令误用 bash 0-索引（`words[2]`）而非 zsh 1-索引（`words[3]`/`CURRENT==3`），真 shell 里只剩顶层补全（评审**执行**生成脚本才发现，子串测试放过）；已修 + 加**执行级**回归测试（source 脚本 + 模拟 widget，zsh/bash 各 2 例）（T3）。②`genPowerShell` **Important**——不补 flag/文件、部分子命令输入失效；已补齐（flag 内嵌 + `CompleteFilename` 文件补全 + `-like` 前缀健壮），逻辑完成但**本机无 pwsh 未执行**→人工 H-10 验证。
**已知限制（defer）：** `FlagSpec.valueArg`（`--out`→dir 值补全）三生成器均未消费，留 `TODO(C1 follow-up)`；bash 文件槽依赖 `bash-completion`；一致性测试守 COMMANDS-vs-KNOWN（两侧手维护）。**测试边界：** 真实 shell tab 行为（尤其 pwsh）= 人工验证（H-10）。

### Phase 3 · P1 — 更多预览类型 ✅ **完成（2026-07-24）**

> 设计：`docs/superpowers/specs/2026-07-24-more-preview-types-design.md`
> 计划：`docs/superpowers/plans/2026-07-24-more-preview-types-p1.md`（含各任务完整 TDD 步骤）
> 范围：文本/代码 + PDF 首页 + 压缩包列表（不含 Office）。执行方式：子代理驱动。

| 任务 | 说明 | 责任人 | 状态 |
|-----|------|--------|------|
| P1-T1 | 核心 `PreviewKind="text"` + manifest 校验放开 + 往返测试 | AI | ✅ 已完成 |
| P1-T2 | `detectStrategy` 重构 + `genText`（前 32KB / UTF-8 边界）+ 测试 | AI | ✅ 已完成 |
| P1-T3 | `genArchive`（zip 中央目录 / tar 头 / tar.gz 内置 zlib 流式早停，上限 500 条）+ 测试 | AI | ✅ 已完成 |
| P1-T4 | `genPdf`（pdftoppm 可选，降级路径）+ `cmdPreview` text→stdout 分流 + 测试 | AI | ✅ 已完成 |

**验收（达成）：** `bun test` **218 全绿 + 1 skip**；typecheck/lint/build 全过。opus 整分支最终评审 **✅ Ready to merge**（安全红线全清：预览字节仍 DEK 加密、云端零可见；生成全在 CLI 层、核心仅 `PreviewKind` 加 text；archive 对抗输入内存+时间双有界、损坏→null；外部工具缺失/失败 + 预览生成任何异常均降级、**绝不阻断上传**）。
**评审拦下并修复的关键项：** ①`genArchive` **解压时间无上限**（构造 .tar.gz 可解压弹 DoS）→ 加 64MB 解压上限 + 负 size clamp + feed 兜底 + 对抗测试（huge-size 跨 chunk / 截断 tar.gz / 超大 zip count）（T3，opus 对抗评审）②`genPdf` PNG 字节存成 `.jpg` 格式不符 → 改 `pdftoppm -jpeg`（T4）③预览生成抛错会阻断上传 → `pushOneFile` 兜 `generatePreview` 抛错 + `mkdtemp` 挪进 try（最终评审）。
**已知限制（defer）：** 外部工具（pdftoppm/ffmpeg）无 spawn 超时（共享既有，病态文件可挂起 push；后续统一加超时→null）；zip/.tar 整包读入内存列名（受 Node 上限保护，超限→null）。**测试边界：** 真实 pdftoppm 抽帧 = 人工验证（H-11）。

### Phase 3 · 其余候选（待细化）

> 进 homebrew-core / winget（待用户量）。worker_threads 已由 S1 澄清定型为上传并发。
> （daemon→D1；shell 补全→C1；更多预览类型→P1。）

---

## v1.1.0 · 云端保险库与配套能力 ✅ **开发完成（2026-07-25，待人工发版）**

> 来源：下游 `../bizhouzizhen`（自珍 GUI）产品设计规格 §7 提出的引擎需求清单 E-1~E-7。
> 设计与计划：`docs/superpowers/plans/2026-07-25-v1.1.0-cloud-vault.md`
> 主旨：让「换机只需重输主密码」这句话第一次真正成立，同时补齐回收站、配额、恢复密钥重导出。

| 任务 | 需求 | 说明 | 状态 |
|-----|------|------|------|
| — | E-1 | 修正「换机只需重输主密码」的错误文档（v1.0.0 已发布，正在误导用户） | ✅ `c5f5863` |
| T1 | E-2 前置 | Backend 通用 blob 原语 `putBlob`/`getBlob`/`removeBlob` | ✅ `dde7c20`+`de637d9` |
| T2 | E-3 | scrypt `N` 2^15 → 2^17（参数存 vault 内，老 vault 向前兼容） | ✅ `ed3b97b` |
| T3 | E-2 + E-4 | 云端保险库 `vault/cloud.ts` + 不透明命名 + listDir 过滤保留名 | ✅ `853855f` |
| T4 | E-2 | CLI 接线：init 上云 / unlock 换机取回与补传 / passwd·recover 重传 / `bz vault sync·status` + 强度关卡 | ✅ `e6d96bb` |
| T5 | E-5 | 恢复密钥重导出 + 轮换 + `bz vault recovery-key [--rotate]` | ✅ `ab9cf49` |
| T6 | E-6 | BaiduBackend `.trash` 回收站（列出/还原/单条删/清空） | ✅ `108d6d3` |
| T7 | E-7 | 网盘配额 `getQuota` + `bz quota` | ✅ `37f8656` |
| T8 | — | 中英文档（README/faq/security/commands）+ `.claude/` 登记表 | ✅ `14cc696` |

**验收（达成）：** `bun test` **303 全绿 + 1 skip**（45 文件）；typecheck 双包通过；biome 无 error。
**关键决策留痕：** ①`fetchCloudVault` 严格区分「云端没有」与「取不到/损坏」——后者退化成 null 会让老用户在新机被误判为新用户、`bz init` 铸新 MK、云端数据永久锁死。②强度关卡做成拦截式而非提示，因为上云后主密码强度是唯一安全边界；`--no-cloud-vault` 是唯一绕过方式且必须显式告知代价。③`rotateRecoveryKey` 先 `verifyMk`，防止用错 MK 覆盖唯一备用入口。④配额失败抛错不回落 0。
**待人工：** 发版（`scripts/bump-minor.sh` → 1.1.0 → npm publish）+ 真机联网验证（H-12 / H-13）。
