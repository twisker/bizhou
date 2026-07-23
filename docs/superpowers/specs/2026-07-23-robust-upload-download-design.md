# 健壮上传/下载 设计（Phase 3 · 并发 + 续传 + 幂等）

> 状态：已认可，待落实现计划。日期：2026-07-23。
> 归属：路线图 Phase 3「打磨与生态」→ 子项「worker_threads 并行加密/上传」经澄清后定型为
> **并发上传（async I/O 并发，不引 worker_threads）+ 续传接线 + 上下行幂等**。

## 背景与动机

M0 实测上行 ~5.5MB/s、下行 ~1.1MB/s（H-03），均为**单流网络受限**。当前实现两处串行：

1. `encryptFileToChunks`（`chunker/index.ts`）逐 100MB 逻辑分片：读→(gzip)→AES-256-GCM→`store.putChunk`（上传）→下一片。
2. `BaiduClient.uploadPart`（`baidu/client.ts`）片内逐个 4MB `superfile2` 传输分片，`for` 循环串行。

**关键量化**：AES-256-GCM 有 AES-NI 加速（单核 GB/s 级），100MB 加密 ≈ 25–100ms；同样 100MB 上传 ≈ 18s。加密仅占上传时间 ~0.3%。**故 worker_threads 并行加密对网络上传几乎零收益；真正的杠杆是上传并发（I/O 并发）。**

同时暴露的健壮性缺口：

- **续传机制在、未接线**：`encryptFileToChunks` 有 `skipExisting` 参数，但 `cmdPush` 从不传；push 中断后重跑会 `generateBundleId()` 生成全新 id 从头再来。
- **不幂等**：每次 push 用新随机 DEK，同文件密文每次不同；manifest 里 `sha256` 是**密文**哈希且 manifest 作为明文 JSON 存云端（仅 `encMeta` 字段加密）。无法靠密文/文件名判断"已存在相同拷贝"。重推 = 云端多一份重复 bundle。
- **下载无续传/无幂等**：`decryptChunksToFile` 每次从 seq 0 全量解密覆盖（`open(outPath,"w")`）。

## 目标

- **G1 并发上传提吞吐**：片内 4MB 分片限流池并发，把单流 5.5MB/s 推向带宽上限。**不引 worker_threads。**
- **G2 续传接线**：中断的 push 能续传（复用 bundleId + `skipExisting`），而非全量重传。
- **G3 上传幂等**：push 前若目标云端目录已有**相同内容**的已完成 bundle，或**同内容正在上传至同目的地**，给出提醒并结束，不产生重复。
- **G4 下载幂等 + 续传**：pull 前若目标本地已有**相同内容**文件，或**同文件正在下载**，提醒并结束；下载走临时文件 + 原子改名 + 分片断点续传。

**非目标**：worker_threads 并行加密（网络场景零收益，另行评估）；跨机器/跨进程的云端锁（本轮用本地锁，云端锁记为远期）；内容寻址的全局去重索引（本轮去重靠扫描目标目录，配合本地 manifest 缓存消除重复网络拉取，见下）。

## Manifest 本地缓存（消除去重扫描的重复网络拉取）

去重扫描要读目标云端目录各 bundle 的 manifest 取 contentId，纯拉取代价随目录内 bundle 数线性增长。加**本地 manifest 缓存**：

```
BIZHOU_HOME/.cache/manifests/<bundleId>.json  = 原始 manifest JSON（encMeta 仍加密）
```

- **只缓存原始 manifest（encMeta 加密态）**，不缓存解出的 contentId → 不把明文内容身份落到本地盘；要省的是网络拉取，本地 `unwrapDek + openMeta` 是内存活儿、便宜。
- **键 = bundleId**（不可变随机 id）。manifest 内容除 `encMeta` 外创建后不变（chunks/contentId/wrappedKey 恒定）；`encMeta` 仅在 `rename` 时改（但 contentId 对 rename 稳定，去重不受影响）。
- **失效**：`rename`（改 encMeta）与 `rm`/`trash`（bundle 消失）→ 删除对应缓存条目；`mv`（仅换目录，manifest 不变）→ 缓存仍有效。命中即用、未命中则拉取后回填。
- 缓存亦可复用于 `info`/`ls` 等读 manifest 的路径（本轮至少在去重扫描接线，其余按需）。`--local` 后端无网络、缓存无害可跳过。

## 绕不开的前提：幂等的"内容身份"

同一文件两次 push 密文完全不同（每次新随机 DEK），且 manifest 明文存云端 → 判断"相同拷贝"**必须**靠明文内容身份，且该身份**绝不能明文暴露给云端**（否则持候选明文者可发起 confirmation attack，对隐私工具是倒退）。

**方案（要求，非偏好）：**

```
contentKey = HKDF-SHA256(ikm=MK, salt="", info="bizhou-content-id", length=32)   // node:crypto hkdfSync
contentId  = HMAC-SHA256(key=contentKey, message=明文)  → hex(64)
```

- **带密钥**：即使字段泄露也不是裸明文哈希；`contentKey` 由 MK 派生 → 不同账号（不同 MK）对同一明文得到不同 contentId，跨账号不可关联。
- **存进加密的 `encMeta`**（新增 `ResourceMeta.contentId`）：云端零可见。去重扫描时本就持 MK，解 `encMeta` 即可读出，零泄露。
- 同明文、同 vault → 同 contentId（稳定），这正是去重/续传/锁三者共用的键。

流式计算：读文件分片时同步喂 HMAC，一次读盘算出（见"实现要点"）。

## 架构与数据流

### S1 · 健壮上传

**核心洞察：一份本地"上传日志"同时充当 锁 + 续传状态。**

```
BIZHOU_HOME/.uploads/<contentId>@<destHash>.json
  { bundleId, cloudDir, contentId, doneChunks: number[], totalChunks, startedAt, pid }
destHash = sha256(normalizeCloudPath(cloudDir)).slice(0,16)
```

`bz push <file> [--to <dir>]` 流程：

```
1. 解锁得 MK；纯读源文件算 contentId（预哈希一遍，本地盘 GB/s，相对上传可忽略）。
2. 去重扫描：列目标云端目录的 bundles；每个 bundleId 先查本地 manifest 缓存，命中免网络、
   未命中则拉取 manifest 并回填缓存；解 encMeta 比 contentId。
   命中"已完成"同内容 bundle → 提醒「已存在相同文件 <id>，跳过」→ 退出（幂等）。
   （--force 跳过此检查，强行重传。）
3. 查上传日志 <contentId>@<destHash>.json：
   a. 存在且 pid 存活或 (now-startedAt) < TTL → 「同文件正在上传至该目录，已结束」→ 退出（在飞锁）。
   b. 存在但已失效（进程不在 + 超 TTL，崩溃残留）→ 续传：复用 bundleId，skipExisting=doneChunks。
   c. 不存在 → 新上传：生成 bundleId，写日志（= 上锁），doneChunks=[]。
4. packResource(..., skipExisting=doneChunks)；每片 putChunk 成功后把 seq 追加进日志 doneChunks 并落盘。
5. 成功 create manifest 后删除日志文件（释放锁）。失败/中断则保留日志供下次续传。
```

`--force` 语义：跳过步骤 2（去重）与 3a（在飞锁），但仍复用 3b 续传（force 不等于放弃已传分片）。

### 并发上传（`uploadPart` 内）

- 25 个 4MB 分片（`blocksToUpload` 过滤后仍需传的）交由**限流池**并发上传，池大小 `concurrency`（默认 4；`--concurrency N` 或 `config.uploadConcurrency` 可调，范围 [1,16]）。
- 分片是内存中 100MB `data` 的 `subarray` → **并发不增内存**，单片驻留不变式保持。
- **fail-fast**：某分片 `withRetry` 耗尽仍失败 → `AbortController.abort()` 取消在飞请求、不调 `create`、抛错。已成功的分片对应的**逻辑分片**尚未完成 create，故该逻辑分片不会记入 `doneChunks`（doneChunks 记的是完成 create 的逻辑分片 seq，粒度=逻辑分片）。
- 进度：`onSlice(partseq, total)` 已存在；聚合为 bytesDone（完成分片数 × 4MB）。

### S2 · 健壮下载（后一轮，对称）

`bz pull <id> [-r] [--out <dir>]` 流程：

```
1. 解锁得 MK；解 manifest 得 contentId 与落地路径 target=downloadLocalPath(...)。
2. 幂等：若 target 已存在 → 流式 hash 该本地文件为 contentId'，== 则「目标已有相同文件，跳过」退出。
3. 下载日志 BIZHOU_HOME/.downloads/<contentId>@<targetHash>.json：
   a. 存活/未超 TTL → 「同文件正在下载」退出（在飞锁）。
   b. 崩溃残留 → 续传：读 doneChunks，跳过已解密写入临时文件的分片。
   c. 不存在 → 新建（上锁）。
4. 解密写入临时文件 target.part（seq 顺序写；每片完成追加 doneChunks 落盘）。
5. 全部完成校验后原子 rename(target.part → target)，删除下载日志。
```

分片断点续传：临时文件 `target.part` + 日志 `doneChunks` 记录已顺序写入的 seq；续传从首个缺失 seq 起（因顺序写盘，doneChunks 必为前缀 [0..k]，续传 = seek 到已写字节数继续）。

## 文件结构（创建/修改）

**核心库 `@bizhou/core`：**
- 新增 `packages/core/src/content/index.ts` — `deriveContentKey(mk): Buffer`（hkdfSync）、`hashPlaintextFile(filePath, contentKey): Promise<string>`（流式 HMAC）、`hashLocalFile` 复用。纯 node，无 Bun API。
- 新增 `packages/core/src/journal/index.ts` — 上传/下载日志读写：`readJournal / writeJournal / markChunkDone / removeJournal / isLockAlive(entry, ttlMs)`；键构造 `journalPath(root, kind, contentId, destPath)`。纯 IO，无网络。
- 新增 `packages/core/src/cache/index.ts` — manifest 缓存：`getCachedManifest(root, bundleId) / putCachedManifest(root, bundleId, raw) / invalidateManifest(root, bundleId)`。只存原始 manifest（encMeta 加密态）。纯 IO，无网络。
- 修改 `packages/core/src/bundle/index.ts` — `ResourceMeta` 增 `readonly contentId?: string`（`sealMeta`/`openMeta` 自动带上，无需改签名）。
- 修改 `packages/core/src/resource/index.ts` — `PackOptions` 增 `contentId?: string`，写入 `meta.contentId`。
- 修改 `packages/core/src/baidu/client.ts` — `uploadPart` 串行 for → 限流池并发 + `AbortController` fail-fast；新增 `concurrency` 参数（默认 4）。
- 修改 `packages/core/src/store/index.ts` / `BaiduBundleStore` — 透传 concurrency 到 uploadPart（若 store 层封装了 uploadPart 调用）。

**CLI `bz`：**
- 修改 `packages/cli/src/commands.ts` — `cmdPush` / `cmdPushDir` 集成：预哈希 contentId、去重扫描（走缓存）、日志锁/续传、`--force`、`--concurrency`、消息；`cmdRename`/`cmdRm`/`cmdTrash` 加缓存失效钩子（`invalidateManifest`）；`cmdPull` / `cmdPullDir`（S2）集成幂等/续传/原子落地。
- 修改 `packages/cli/src/index.ts` — `push` 增 `--force` `--concurrency N`；HELP 更新；（S2）`pull` 同。
- 修改 `packages/core/src/config/index.ts` — `Config` 增 `uploadConcurrency?: number`（可选，默认 4）。

## 并发上传池的错误/取消语义

- 池内每个 worker：取下一个待传 index → `withRetry(uploadSlice)`。任一 worker 抛错 → 置共享 `aborted` 标志 + `AbortController.abort()`；其余 worker 检查标志即停；`uploadPart` 抛首个错误。
- `uploadSlice` 需接受可选 `signal` 透传给 `this.http`（fetch 支持 `signal`），使在飞请求可被取消。
- create 只在**全部**分片成功后调用；部分成功不 create → 该逻辑分片不记 doneChunks，下次续传时 precreate 的 `blocksToUpload` 天然只补缺失的 4MB 块（片内续传由百度侧幂等保证），逻辑分片续传由 doneChunks 保证。
- **不静默**：任何最终失败都抛 `BizhouError`，绝不返回损坏/半份结果（符合安全红线）。

## 测试策略（TDD，先写失败测试）

**contentId（`content/index.ts`）**
- 同明文 + 同 MK → 同 contentId；不同 MK → 不同 contentId（带密钥性质）。
- 流式 `hashPlaintextFile` 与一次性 HMAC 结果一致（正确性）。

**并发池（`baidu/client.ts`，mock http/uploadSlice）**
- N 路并发：断言任一时刻在飞 ≤ concurrency；乱序完成仍全部上传；结果与串行等价。
- fail-fast：注入某分片持续失败 → 断言 abort 被调用、未调 create、抛出该错误。

**上传日志（`journal/index.ts`）**
- 新建/追加 doneChunks/删除往返；`isLockAlive` 对存活 pid 判活、对不存在 pid+超 TTL 判死。

**manifest 缓存（`cache/index.ts`）**
- put→get 往返得原始 manifest；`invalidateManifest` 后 get 返回未命中；缓存只存加密态（断言存盘内容不含明文 contentId）。
- 去重扫描命中缓存时不触发网络拉取（mock store，断言 getManifest 调用次数为 0）。

**cmdPush 集成（内存后端）**
- 去重：两次 push 同内容到同目录 → 第二次检测到已存在、跳过、不新增 bundle。
- 续传：模拟中断（第 2 片后抛错）→ 日志留 doneChunks=[0,1] → 重跑 skipExisting=[0,1]、只传剩余、成功后删日志。
- 在飞锁：预置存活日志 → push 同内容 → 提醒并退出、不上传。
- `--force`：绕过去重与锁，仍新传（或复用续传）。

**S2 下载（后一轮同规格）**：幂等跳过、在飞锁、临时文件原子改名、分片续传、GCM 校验失败即抛不写出。

## 里程碑拆分

- **S1 · 健壮上传**（本轮）：contentId 底座 → 并发池 → 上传日志 → manifest 缓存（含 rename/rm/trash 失效钩子）→ cmdPush 集成（去重走缓存）→ 递归 push 集成。约 6 个 TDD 任务。
- **S2 · 健壮下载**（后一轮）：下载幂等 + 在飞锁 + 临时文件原子落地 + 分片续传。复用 contentId 底座。

## 安全红线自检

- contentId 带密钥且仅存加密 encMeta → 云端零明文身份泄露。
- 密钥/凭证不入日志文件（.uploads/.downloads 只存 bundleId/seq/pid/时间，无 DEK/MK/口令）。
- 任何解密路径 GCM 校验失败即抛错，不静默写损坏数据（下载续传/原子改名保持此不变式）。
- 核心库只发事件、不 print；锁/续传交互与提醒留在 CLI 层。
- 无新增外部运行时依赖（HKDF/HMAC 用 node:crypto 内置）。
