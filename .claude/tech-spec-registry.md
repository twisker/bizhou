# 技术规格登记表

本文件记载 **敝帚（Bìzhǒu）** 各模块使用的技术栈、算法规范和技术规格。

---

## 1. 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 语言 | TypeScript（strict） | 单语言、生态成熟、类型安全 |
| 运行时（主） | **Bun** | 内置 `crypto`（AES-256-GCM + scrypt）、启动快；作为主目标运行时 |
| 运行时（兼容） | Node LTS | 核心库须同时兼容 Node LTS，保证可嵌入任意 Node 前端/自动化 |
| 包管理 / 仓库 | **pnpm workspaces（monorepo）** | `packages/core` + `packages/cli` 两个独立发布单元 |
| 测试 | **`bun test`** | 单元 + 集成测试；集成测试覆盖百度接口（可用 mock / 录制回放） |
| 大文件加密 | `worker_threads` | 分片加密并行、避免阻塞主线程 |
| 加密算法 | AES-256-GCM（AEAD） | 机密性 + 完整性/防篡改，用运行时内置 `crypto`，零外部二进制依赖 |
| 密钥派生（KDF） | scrypt（首选）/ argon2id | 由用户主密码派生 KEK；加盐；参数记入 manifest |
| 压缩（可选） | gzip（内置）/ zstd（可选） | 先压缩再加密；媒体文件默认关闭 |
| 百度对接 | 直连 REST + OAuth2 | 官方无 JS SDK；`xpan/file` + `pcs/superfile2` + download |
| 凭证/密钥存储 | OS 钥匙串 | macOS Keychain / Windows Credential Manager / Linux Secret Service |
| 7z 导出 | `node-7z` + `7zip-bin`（评估中） | 7z-AES + 头部加密（藏文件名）；导出后可脱离本工具解密 |
| Lint / 格式化 | ESLint + Prettier（或 Biome） | 提交前检查；CI 强制 |

> 运行时说明：以 **Bun 优先**，但 `@bizhou/core` 不得使用 Bun 专有 API，须在 Node LTS 下等价运行。CLI 层可使用 Bun 特性，但需保证 Node 下亦可用（分发要求）。

---

## 2. 配色体系

不适用（本项目为 CLI + 库，无图形界面）。

> CLI 输出的颜色/样式约定（如成功=绿、警告=黄、错误=红、进度=灰）在开发 CLI 层时于本节补充。

---

## 3. 布局规范

不适用（无 GUI）。

**CLI 交互约定（占位，开发时细化）：**
- 退出码：`0` 成功；非 0 表示错误类别（网络/鉴权/密钥/参数）。
- 进度：长任务（上传/下载/加密）通过核心库**进度事件**驱动 CLI 进度条。
- 交互：主密码/口令输入走隐藏输入；绝不回显、绝不写日志。

---

## 4. 通用组件规范

不适用（无前端组件）。核心库对外的**编程接口约定**在 `module-spec-registry.md` 中登记。

---

## 5. 核心 API 依赖（百度网盘开放平台）

| 接口 | 用途 | 状态 |
|------|------|------|
| OAuth 2.0（授权码 / device-code） | 获取/刷新 access token | 已实现（mock 测试），联网待验（M0） |
| `xpan/file` · precreate | 预创建、拿 `uploadid` | 已实现（mock 测试），联网待验 |
| `pcs/superfile2` | 逐 4MB 分片上传（`partseq`） | 已实现（mock 测试），联网待验 |
| `xpan/file` · create | 合并落盘到 `/apps/bizhou/<bundle>/NNN.part` | 已实现（mock 测试），联网待验 |
| `xpan/file` · list | 列出 `/apps/bizhou/` 下的 bundle | 已实现，联网待验 |
| `xpan/multimedia` · filemetas + dlink | 取下载直链 | 已实现，联网待验 |
| `xpan/file` · filemanager(delete) | 删除资源 | 已实现，联网待验 |
| download（dlink） | 下载分片与预览包 | 已实现，联网待验 |

### 真实端点接线验证（2026-07-23，未授权探测，不发 secret）

对生产端点做过一次**接线正确性**验证（不含用户授权，不完成 M0）：

- **OAuth 设备码初始化**：用真实 appKey 调 `openapi.baidu.com/oauth/2.0/device/code` **成功**，返回真实 user_code + 验证 URL + 二维码 → 证明 appKey 有效、OAuth 请求格式正确、端点可达。仅差用户在浏览器输入 user_code 授权。
- **文件 API 探测**：用非法 token 调 `pan.baidu.com/.../file?method=list&dir=/apps/bizhou` 返回结构化 `{"errno":-6}`（鉴权失败）→ 证明 URL/method/参数正确、客户端 errno 处理路径正确。
- **可达性**：`openapi.baidu.com` ✓、`pan.baidu.com`（下载/list）✓、**`d.pcs.baidu.com`（superfile2 上传）从当前环境不可达（超时）**。→ **运行 `bz` 的机器必须能访问 `d.pcs.baidu.com` 才能上传**；M0 联网往返须在具备该出网的机器上跑（`scripts/m0-verify.sh` 已加预检）。
- **无人工 token 的可能性已排除**：三种 OAuth 授权类型均已实测——授权码流/设备码流均需用户浏览器授权；`client_credentials`（app 级、无用户）请求 netdisk scope 返回 `invalid_scope`。原因：xpan/netdisk API 操作的是**特定用户**的 `/apps/bizhou/` 空间，必须用户级 token，app token 无用户上下文。→ **获取可用 token 只能由用户在浏览器授权，无自动化绕过路径（Baidu 安全设计）。**
- `d.pcs.baidu.com` 从本沙盒**间歇可达**（一次 HTTP 400/2s，多次超时）——真实上传需稳定出网到该主机。
- 结论：整条集成链路在真实端点上验证到「人工授权墙」之前均正确；剩余仅为用户浏览器授权 + 在可稳定访问 d.pcs 的机器上跑一次往返。自动化形态见 `packages/core/test/baidu.live.test.ts`（`BIZHOU_LIVE=1 BAIDU_ACCESS_TOKEN=… bun test`）。

### M0 关键验证 —— 真实百度网盘往返（2026-07-23，✅ 通过）

由人工在真实账号上执行 `scripts/m0-verify.sh 500`，结果：

- **500MB 加密文件真实上传 → 下载 → SHA-256 字节级一致** ✅
- **云端未因"内容不可识别的加密大文件"而限制/封禁**（全程无 errno、无频率限制报错）→ **全案前提成立** ✅
- 整条对接链首次真实联网即跑通：OAuth token → precreate/superfile2(4MB)/create → list/filemetas/dlink 下载 → filemanager 删除。
- **实测吞吐**：上行 ≈ 5.5 MB/s（500MB / 93s）；下行 ≈ 1.1 MB/s（500MB / 470s）。
- **配额/限流观察**：本次单文件 500MB（5 个 100MB 逻辑分片 × 若干 4MB 传输分片）未触发任何限流；下行明显慢于上行，判断为**百度免费账号 dlink 下载限速**（已知行为，非本工具问题）。
- **据此的并发/退避建议**：上传瓶颈在带宽而非 QPS，串行分片即可；下载受 dlink 限速，未来可考虑多 dlink 并发。当前 3 次指数退避重试足够（本次无重试触发）。

> 后续如需更精确的 QPS/配额上限，可跑更大文件或并发多资源压测；M0 前提已满足，不阻塞发布。

**沙盒约束**：应用只能操作 `/apps/bizhou/` 单一目录。
**单文件上限**：普通用户 4GB / SVIP 20GB → 用 100MB 逻辑分片规避。
**凭证**：用户自备 AppKey/SecretKey，工具**不内嵌任何凭证**。
**QPS/配额**：官方未公开，**M0 实测**后据此设并发与退避策略。

---

## 5.1 密钥架构定稿（AI 自主决策留痕）

对 PRD §7 信封加密的稳健化落地，已实现于 `packages/core/src/vault`：

```
主密码 ──scrypt(N=2^15,r=8,p=1,NFKC,加盐)──▶ KEK_pw ─┐
                                                      ├─包裹─▶ MK（随机主密钥）──包裹─▶ 各资源 DEK
恢复密钥(32B 随机, base32 展示) = KEK_rk ──────────────┘
```

- **MK 间接层**：引入随机主密钥 MK，只生成一次；每个资源 DEK 由 MK 包裹后存 `manifest.wrappedKey`。
- **双路解锁**：MK 分别被 KEK_pw 与恢复密钥各包裹一份，存本地 `vault.json`（明文安全——只含被包裹密钥）。
- **改主密码**只需重裹 MK，不动任何资源 manifest；忘主密码用恢复密钥解 MK 再重设。
- **与 PRD 差异**：原 PRD 将 DEK 直接用主密码 KEK 包裹、KDF/盐入 manifest；现改为 DEK 由 MK 包裹、KDF/盐入 vault，故 manifest 不再含 kdf/salt。差异已在此登记。
- **分片 AAD**：每分片以 `bundleId:seq` 作为 GCM AAD，绑定密文位置，防跨资源/乱序移花接木。
- **token 存储**：设备密钥（首次随机、0600）AES-256-GCM 加密 `secrets.enc`（`FileSecretStore`）；OS 钥匙串后端可实现同接口后替换。

### 5.1.1 确定性分片 IV（断点续传所需，安全红线留痕）

为使断点续传中"跳过重传的分片"其 manifest 记录（iv/tag/sha256）与云端已存密文**逐字节一致**，分片 IV 由 DEK 确定性派生，而非随机：

```
IV = HMAC-SHA256(DEK, "<bundleId>:<seq>")[:12]   // 即 deriveDeterministicIv(dek, chunkAad(bundleId, seq))
```

- **实现**：`packages/core/src/crypto/deriveDeterministicIv` + `chunker/encryptFileToChunks`。IV 用 DEK 自身作 HMAC 密钥（密钥分离可选，当前未拆分子密钥；IV 无需保密、只需唯一）。
- **唯一性不变量（GCM 铁律：绝不用同一 `(key, IV)` 加密不同明文）**：
  1. `key = DEK`，每个新 bundle 由 CSPRNG 随机生成，互不相同；
  2. `aad = "bundleId:seq"`，同一 bundle 内每分片唯一 → 同一 DEK 下每个 seq 的 IV 唯一；
  3. **续传时 DEK、bundleId、chunkSize、compression 全部从 journal 固定还原**（`JournalEntry` 新增 `chunkSize`/`compression`，`pushOneFile` 续传路径忽略本次不同的 `--chunk/--no-split/--compress` 并 `warn`）→ `seq→明文` 映射与首次完全一致，重加密逐字节可复现。
- **唯一可能的 `(key, IV)` 重复**仅出现在"续传重算同一 seq"，而此时明文必然与首次相同（由 1、3 保证），属幂等重算，**不是 nonce 复用**。
- **历史漏洞（已闭合）**：曾仅凭 `contentId`（文件内容指纹）判定"文件未变"就认为 IV 安全，但 `seq→明文` 还取决于 chunkSize 与 compression——续传改用不同 `--chunk/--no-split/--compress` 会让同一 `(DEK, bundleId, seq)` 覆盖**不同明文** → 灾难性 AES-GCM nonce 复用（机密性击穿 + GHASH/tag 伪造）。修复：把 chunkSize/compression 一并钉进 journal 并在续传时强制沿用。
- **manifest schema 不变**：IV 照旧逐分片存于 `manifest.chunks[].iv`。解密只读 manifest 里的 IV，与派生方式无关，故**老 bundle 照常解密**、无迁移成本。

## 6. 性能与安全要求

| 要求 | 说明 |
|------|------|
| 版本管理 | 遵循 `major.minor.patch`，patch 自动递增（git hook），major/minor 人工触发 |
| 往返一致性 | 上传→下载→解密→合并后必须**字节级一致**（SHA-256 校验），作为核心库硬性测试 |
| 加密完整性 | AES-256-GCM tag 校验失败即拒绝解密并报错，绝不静默返回损坏数据 |
| 密钥隔离 | DEK/KEK/主密码/token **全程只在客户端**，不上传、不托管、不入库、不写明文日志 |
| 端到端 | 无主密码任何人不可解；换机/重装只需重输主密码（机器无关） |
| 恢复兜底 | `bz init` 生成恢复密钥，忘主密码时可恢复；引导用户离线保管 |
| 大文件不阻塞 | 分片加密走 `worker_threads`；内存占用与文件大小解耦（流式处理） |
| 断点续传 | 复用云端 `uploadid`；上传中断可续传 |
| 零外部二进制依赖（加密） | AES/KDF 全用运行时内置 `crypto`，保证可审计、跨平台一致 |
| 可审计 | 代码中无任何硬编码秘密；KDF 参数、算法标识写入 manifest 明文，便于审计 |
