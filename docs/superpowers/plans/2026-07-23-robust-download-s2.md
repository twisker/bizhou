# S2 · 健壮下载 实现计划（幂等 + 在飞锁 + 分片续传 + 原子落地）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bz pull` 具备内容级幂等（目标已有相同文件则跳过）、在飞锁（同文件正在下载则跳过）、分片断点续传（临时文件 + 逐片顺序写 + 崩溃可续），并在交付前做端到端 `contentId` 校验后原子改名落地。

**Architecture:** 复用 S1 已落地的 `content`（contentId/hashPlaintextFile）、`journal`（在飞锁+续传状态，下载复用 `kind:"download"`）、`cache` 三模块。核心改 `decryptChunksToFile`/`unpackResource` 支持 `skip` 续传 + 定位写入临时文件；CLI 抽出共用 `pullOneBundle`（幂等→锁/续传→解密到 `.part`→端到端校验→原子改名），`cmdPull` 单文件与 `pull -r` 递归共用。

**Tech Stack:** TypeScript + Bun 测试；核心库仅 `node:` 内置。

**Spec:** `docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`（S2 段）。**依赖：** S1（`feature/phase3`）已完成——`content`/`journal`/`cache` 模块、`hashPlaintextFile`、`deriveContentKey`、`ResourceMeta.contentId`、`journalPath/readJournal/writeJournal/appendDoneChunk/removeJournal/isLockAlive`、CLI 侧 `pidAlive`/`deriveContentKey` 均已存在。

## Global Constraints

- 核心库 `@bizhou/core` **不得用 Bun 专有 API**（Node LTS 等价）；**零新增外部运行时依赖**（仅 `node:` 内置）。
- 核心库**只发事件、绝不 print**；**绝不读时钟**（`now`/`startedAt`/`pid` 由 CLI 注入）。
- 任何解密路径 **GCM 校验失败 / sha256 不符即抛错**，**绝不静默写出损坏数据**；**绝不把损坏/半份文件当成品交付**（未通过端到端校验不得 rename 到最终路径）。
- 下载日志文件**不得含任何密钥/凭证**（只存 bundleId/cloudDir/contentId/seq/pid/时间戳）。
- **续传的正确性以"端到端 contentId 校验"兜底**：装配完临时文件后，若 manifest 有 `contentId`，必须 `hashPlaintextFile(临时文件)==contentId` 才交付；不符即报错、保留 `.part` 供重试、**绝不 rename**。对无 `contentId` 的旧 bundle，退化为逐片密文 sha256 校验（下载路径已有），不做端到端校验。
- 版本号由 pre-commit `scripts/bump-version.sh` 自动处理，任务内**不手改** VERSION/package.json 版本。

---

### Task 1: 核心续传支持（decryptChunksToFile skip + 定位写入；journal 上传专属字段改可选）

**Files:**
- Modify: `packages/core/src/chunker/index.ts`（`decryptChunksToFile` 增 `skip` + 定位写入 + 收尾 truncate）
- Modify: `packages/core/src/resource/index.ts:131-159`（`UnpackOptions.skip` 透传）
- Modify: `packages/core/src/journal/index.ts`（`wrappedKey`/`chunkSize`/`compression` 改可选——下载日志用不到）
- Test: `packages/core/test/decrypt-resume.test.ts`
- Test: `packages/core/test/journal.test.ts`（追加：下载态 entry 无上传专属字段仍合法）

**Interfaces:**
- Consumes: `ChunkInfo`（已含 `seq`/`plainSize`/`iv`/`tag`/`sha256`）。
- Produces:
  - `DecryptFileOptions.skip?: readonly number[]`（已写入的 seq，续传时跳过下载/解密，仅推进写入偏移）。
  - `UnpackOptions.skip?: readonly number[]`（透传）。
  - `JournalEntry` 的 `wrappedKey`/`chunkSize`/`compression` 变为可选（上传写入、下载省略）。

- [ ] **Step 1: 写失败测试** `packages/core/test/decrypt-resume.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { encryptFileToChunks, decryptChunksToFile } from "../src/chunker/index.ts";
import { generateKey } from "../src/crypto/index.ts";
import { MemoryBundleStore } from "../src/store/index.ts";
import { mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("decryptChunksToFile 续传（skip）", () => {
  test("skip 已写分片 → 定位续写，结果与全量解密字节一致", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-dlr-"));
    try {
      const dek = generateKey();
      const bundleId = "abcd";
      const original = Buffer.concat([
        Buffer.alloc(100, 1),
        Buffer.alloc(100, 2),
        Buffer.alloc(50, 3),
      ]); // 250B → chunkSize 100 → seq 0/1/2
      const src = join(dir, "src.bin");
      await writeFile(src, original);
      const store = new MemoryBundleStore(bundleId);
      const chunks = await encryptFileToChunks({
        filePath: src,
        fileSize: original.length,
        dek,
        bundleId,
        chunkSize: 100,
        compression: "none",
        store,
      });

      // 模拟"seq 0 已写入临时文件"：预置 .part 只含 seq0 的明文（前 100 字节）
      const part = join(dir, "out.bin.part");
      const fh = await open(part, "w");
      await fh.write(original.subarray(0, 100), 0, 100, 0);
      await fh.close();

      const { bytesWritten } = await decryptChunksToFile({
        chunks,
        dek,
        bundleId,
        compression: "none",
        store,
        outPath: part,
        skip: [0], // 跳过 seq0（不 getChunk），续写 seq1/2
      });

      expect(bytesWritten).toBe(original.length);
      expect(await readFile(part)).toEqual(original); // 字节级一致
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skip 空 → 与旧行为一致（全量新建写出）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-dlr2-"));
    try {
      const dek = generateKey();
      const original = Buffer.alloc(300, 7);
      const src = join(dir, "s.bin");
      await writeFile(src, original);
      const store = new MemoryBundleStore("z");
      const chunks = await encryptFileToChunks({
        filePath: src, fileSize: 300, dek, bundleId: "z", chunkSize: 100, compression: "none", store,
      });
      const out = join(dir, "o.bin");
      await decryptChunksToFile({ chunks, dek, bundleId: "z", compression: "none", store, outPath: out });
      expect(await readFile(out)).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/decrypt-resume.test.ts`
Expected: FAIL（`decryptChunksToFile` 尚无 `skip`；`skip:[0]` 会尝试 getChunk(0) 或顺序写覆盖）。

- [ ] **Step 3: 改 `decryptChunksToFile`（定位写入 + skip + 收尾 truncate）**

替换 `packages/core/src/chunker/index.ts` 的 `DecryptFileOptions` 与 `decryptChunksToFile`：

```ts
export interface DecryptFileOptions {
  readonly chunks: readonly ChunkInfo[];
  readonly dek: Buffer;
  readonly bundleId: string;
  readonly compression: Compression;
  readonly store: BundleStore;
  readonly outPath: string;
  /** 续传：这些 seq 已写入 outPath，跳过下载/解密，仅推进写入偏移。 */
  readonly skip?: readonly number[];
  readonly onProgress?: ProgressCallback;
}

/** 逐片读出、校验、解密、按偏移写入 outPath。skip 内的 seq 视为已在文件中，跳过。 */
export async function decryptChunksToFile(
  opts: DecryptFileOptions,
): Promise<{ bytesWritten: number }> {
  const totalChunks = opts.chunks.length;
  const bytesTotal = opts.chunks.reduce((a, c) => a + c.plainSize, 0);
  const skip = new Set(opts.skip ?? []);
  const resuming = skip.size > 0;
  let bytesDone = 0;
  // 续传写已存在的 .part 用 "r+"（保留已写字节、可越界写）；否则 "w"（新建/截断）。
  const fh = await open(opts.outPath, resuming ? "r+" : "w");
  try {
    let position = 0;
    for (const info of opts.chunks) {
      if (skip.has(info.seq)) {
        position += info.plainSize; // 该片已在文件中，跳过写入、仅推进偏移
        bytesDone += info.plainSize;
        opts.onProgress?.({ phase: "decrypt", seq: info.seq, totalChunks, bytesDone, bytesTotal });
        continue;
      }
      const ct = await opts.store.getChunk(info.seq);
      if (sha256hex(ct) !== info.sha256) {
        throw new BizhouError("CHUNK", `分片 ${info.seq} 密文 sha256 校验失败（数据损坏或被篡改）`);
      }
      const iv = Buffer.from(info.iv, "base64");
      const tag = Buffer.from(info.tag, "base64");
      const payload = aeadDecrypt(opts.dek, iv, ct, tag, chunkAad(opts.bundleId, info.seq));
      const plain = opts.compression === "gzip" ? gunzipSync(payload) : payload;
      if (plain.length !== info.plainSize) {
        throw new BizhouError(
          "CHUNK",
          `分片 ${info.seq} 还原长度 ${plain.length} 与 manifest plainSize ${info.plainSize} 不符`,
        );
      }
      await fh.write(plain, 0, plain.length, position); // 定位写入（支持续传乱序补齐）
      position += plain.length;
      bytesDone += plain.length;
      opts.onProgress?.({ phase: "decrypt", seq: info.seq, totalChunks, bytesDone, bytesTotal });
    }
    await fh.truncate(position); // 收尾：精确文件长度（防旧 .part 更长残留尾字节）
    return { bytesWritten: bytesDone };
  } finally {
    await fh.close();
  }
}
```

- [ ] **Step 4: `UnpackOptions.skip` 透传**

`packages/core/src/resource/index.ts`：`UnpackOptions` 增 `readonly skip?: readonly number[];`，并在 `unpackResource` 调用 `decryptChunksToFile` 时带上 `skip: opts.skip`。

- [ ] **Step 5: journal 上传专属字段改可选**

`packages/core/src/journal/index.ts`：把 `JournalEntry` 的 `wrappedKey`/`chunkSize`/`compression` 改为可选：

```ts
export interface JournalEntry {
  readonly bundleId: string;
  readonly cloudDir: string;
  readonly contentId: string;
  readonly doneChunks: number[];
  readonly totalChunks: number;
  readonly startedAt: string;
  readonly pid: number;
  /** 上传专属：MK 包裹的 DEK（续传复用同一 DEK）。下载省略。 */
  readonly wrappedKey?: string;
  /** 上传专属：固定分片大小（续传沿用防 nonce 复用）。下载省略。 */
  readonly chunkSize?: number;
  /** 上传专属：固定压缩方式。下载省略。 */
  readonly compression?: Compression;
}
```

`isValidJournalEntry` 改为：必需字段仍校验（bundleId/cloudDir/contentId 字符串、doneChunks 为数字数组、totalChunks/pid 数字、startedAt 字符串）；上传专属字段**若存在**才校验类型：

```ts
function isValidJournalEntry(e: unknown): e is JournalEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  const common =
    typeof o.bundleId === "string" &&
    typeof o.cloudDir === "string" &&
    typeof o.contentId === "string" &&
    Array.isArray(o.doneChunks) &&
    o.doneChunks.every((n) => typeof n === "number") &&
    typeof o.totalChunks === "number" &&
    typeof o.startedAt === "string" &&
    typeof o.pid === "number";
  if (!common) return false;
  if (o.wrappedKey !== undefined && typeof o.wrappedKey !== "string") return false;
  if (o.chunkSize !== undefined && typeof o.chunkSize !== "number") return false;
  if (o.compression !== undefined && o.compression !== "none" && o.compression !== "gzip") return false;
  return true;
}
```

追加 `packages/core/test/journal.test.ts` 一条测试：一个不含 `wrappedKey`/`chunkSize`/`compression` 的下载态 entry `write→read` 往返合法（`readJournal` 不返回 null）。

- [ ] **Step 6: 运行测试确认通过 + 回归**

Run: `bun test packages/core/test/decrypt-resume.test.ts packages/core/test/journal.test.ts && bun test`
Expected: 新测试 PASS；既有（含 S1 上传日志、加密往返）无回归。

- [ ] **Step 7: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/chunker/index.ts packages/core/src/resource/index.ts packages/core/src/journal/index.ts packages/core/test/decrypt-resume.test.ts packages/core/test/journal.test.ts`

```bash
git add packages/core/src/chunker/index.ts packages/core/src/resource/index.ts packages/core/src/journal/index.ts packages/core/test/decrypt-resume.test.ts packages/core/test/journal.test.ts
git commit -m "feat(core): decryptChunksToFile 支持 skip 续传（定位写入+收尾truncate）+ journal 上传专属字段改可选"
```

---

### Task 2: cmdPull 集成（幂等 + 在飞锁 + 续传 + 端到端校验 + 原子落地）

**Files:**
- Modify: `packages/cli/src/commands.ts`（新增 `pullOneBundle` helper + `downloadJournalKey`；改写 `cmdPull` 单文件分支调用它）
- Modify: `packages/cli/src/index.ts`（`pull` 增 `--force`；HELP 更新）
- Test: `packages/cli/test/pull-idempotency.test.ts`

**Interfaces:**
- Consumes: `hashPlaintextFile`/`deriveContentKey`（S1）、journal API、`readResourceMeta`/`unpackResource`、`downloadLocalPath`、`pidAlive`（S1，CLI 内已有）。
- Produces:
  - `pullOneBundle(rt, backend, mk, contentKey, fullId, dir, outPath, opts): Promise<{ status: "restored" | "skipped-dup" | "locked" | "resumed"; bytesWritten: number }>` —— 供 `cmdPull` 单文件与 `pull -r`（Task 3）共用。

**决策常量：** 下载锁 TTL = `DOWNLOAD_LOCK_TTL_MS = 30 * 60 * 1000`。下载日志键：`contentId`（新 bundle）或 `bundleId`（旧 bundle 无 contentId），目的地哈希用 `outPath`。

- [ ] **Step 1: 写失败测试** `packages/cli/test/pull-idempotency.test.ts`

> 复用/扩展 S1 的内存夹具能力：需要一个内存 backend + 一个已 pack 好的 bundle（含 contentId），并能驱动 `pullOneBundle`。夹具增 `packBundle(bytes, opts?)`（用 packResource 造一个内存 bundle，返回 `{fullId, dir}`）与 `pullOne(fullId, dir, outPath, opts?)` 包装，以及一个固定 keyRoot 作为 `rt.paths.dir`。

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePullFixture } from "./helpers/memory-fixture.ts";

describe("pull 幂等/锁/续传（内存后端）", () => {
  test("往返：pull 出的字节与原文件一致，并原子落到最终路径（无 .part 残留）", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(250, 5);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "restored.bin");
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("restored");
      expect(await readFile(out)).toEqual(data);
      expect(await fx.exists(`${out}.part`)).toBe(false); // 已原子改名，无临时残留
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("幂等：目标已有相同内容 → skipped-dup，不重下载", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(120, 9);
      const { fullId, dir } = await fx.packBundle(data);
      const out = join(fx.tmp, "x.bin");
      await fx.pullOne(fullId, dir, out, {});
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("skipped-dup");
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("在飞锁：预置存活下载日志 → locked，不下载", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(80, 1);
      const { fullId, dir } = await fx.packBundle(data);
      const out = join(fx.tmp, "y.bin");
      await fx.writeLiveDownloadLock(fullId, dir, out); // startedAt=now, pid=process.pid
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("locked");
      expect(await fx.exists(out)).toBe(false);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("续传：崩溃残留（.part 已含 seq0 + 日志 doneChunks=[0]）→ resumed，seq0 不再 getChunk，且字节一致", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.concat([Buffer.alloc(100, 2), Buffer.alloc(100, 3), Buffer.alloc(30, 4)]);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "z.bin");
      const seen = await fx.seedResume(fullId, dir, out, data, { chunkSize: 100, doneChunks: [0] });
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("resumed");
      expect(seen.getChunkCalls).not.toContain(0); // seq0 被 skip
      expect(await readFile(out)).toEqual(data); // 端到端一致
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("端到端校验：装配后的文件 contentId 不符 → 抛错、不交付（保留 .part、无最终文件）", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(200, 6);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "bad.bin");
      // 注入损坏：seedResume 声称 doneChunks=[0] 但 .part 的 seq0 明文被篡改（内容与原不符）
      await fx.seedResumeCorrupt(fullId, dir, out, { chunkSize: 100, doneChunks: [0] });
      await expect(fx.pullOne(fullId, dir, out, {})).rejects.toThrow();
      expect(await fx.exists(out)).toBe(false); // 绝不交付损坏文件
      expect(await fx.exists(`${out}.part`)).toBe(true); // 保留供排查/重试
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
```

> **实现者注意**：`test/helpers/memory-fixture.ts` 需扩展这些能力：`makePullFixture()`、`packBundle(bytes, {chunkSize?})`→用 `packResource`+固定 MK 造内存 bundle（含 contentId）返回 `{fullId, dir}`、`pullOne(...)`→调 `pullOneBundle`、`writeLiveDownloadLock`/`seedResume`/`seedResumeCorrupt`（用 `journalPath("download",…)`+`writeJournal` 预置日志、并把 `.part` 预置为对应的明文/篡改明文）、`exists(path)`。内存 backend 的 `bundleStore` 用记录 `getChunk` 调用的包装（`getChunkCalls`）。夹具应导出被测的 `pullOneBundle`（在 `commands.ts` 中 `export` 它）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/pull-idempotency.test.ts`
Expected: FAIL（`pullOneBundle`/夹具不存在）。

- [ ] **Step 3: 实现 `pullOneBundle` + `downloadJournalKey`（`commands.ts`）**

新增（从 `@bizhou/core` 补引入 `hashPlaintextFile`；`deriveContentKey`/`readResourceMeta`/`unpackResource`/`journalPath`/`readJournal`/`writeJournal`/`appendDoneChunk`/`removeJournal`/`isLockAlive` 若未引入则补）：

```ts
const DOWNLOAD_LOCK_TTL_MS = 30 * 60 * 1000;

/** 下载日志键：新 bundle 用 contentId，旧 bundle（无 contentId）退回 bundleId。 */
function downloadJournalKey(contentId: string | undefined, bundleId: string): string {
  return contentId && contentId.length > 0 ? contentId : bundleId;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface PullOneOpts {
  force?: boolean;
}

/** 单 bundle 下载内核：幂等→锁/续传→解密到 .part→端到端校验→原子改名。cmdPull 与 pull -r 共用。 */
export async function pullOneBundle(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  fullId: string,
  dir: string,
  outPath: string,
  opts: PullOneOpts,
): Promise<{ status: "restored" | "skipped-dup" | "locked" | "resumed"; bytesWritten: number }> {
  const store = backend.bundleStore(fullId, dir);
  const { manifest, meta } = await readResourceMeta(mk, store);
  const cid = meta.contentId; // 可能 undefined（旧 bundle）
  const jkey = downloadJournalKey(cid, fullId);
  const jpath = journalPath(rt.paths.dir, "download", jkey, outPath);
  const partPath = `${outPath}.part`;

  // 1. 幂等：目标已存在且内容相同 → 跳过（仅当有 contentId 可比对）
  if (!opts.force && cid && (await fileExists(outPath))) {
    if ((await hashPlaintextFile(outPath, contentKey)) === cid) {
      warn(`目标已有相同文件，跳过：${outPath}`);
      return { status: "skipped-dup", bytesWritten: 0 };
    }
  }

  // 2. 查下载日志：锁 or 续传 or 新建
  const existing = await readJournal(jpath);
  let skip: number[] = [];
  let status: "restored" | "resumed" = "restored";
  if (existing) {
    const alive = isLockAlive(existing, {
      ttlMs: DOWNLOAD_LOCK_TTL_MS,
      now: rt.now(),
      pidAlive: pidAlive(existing.pid),
    });
    if (alive && !opts.force) {
      warn(`同文件正在下载，本次跳过：${outPath}`);
      return { status: "locked", bytesWritten: 0 };
    }
    // 崩溃残留（或 --force）→ 续传，但仅当 .part 仍在；否则从头
    if (await fileExists(partPath)) {
      skip = existing.doneChunks;
      status = "resumed";
    }
  }

  await mkdir(dirname(outPath), { recursive: true });

  // 3. 写日志（上锁）
  await writeJournal(jpath, {
    bundleId: fullId,
    cloudDir: dir,
    contentId: cid ?? "",
    doneChunks: skip,
    totalChunks: manifest.chunks.length,
    startedAt: new Date(rt.now()).toISOString(),
    pid: process.pid,
  });

  // 4. 解密到 .part；每片写完把 seq 追加进日志（串行链，err-on-safe：日志滞后只会重下，绝不跳缺片）
  let chain: Promise<void> = Promise.resolve();
  let bytesWritten = 0;
  try {
    const res = await unpackResource({
      mk,
      store,
      outPath: partPath,
      skip,
      onProgress: (e) => {
        renderProgress("解密", e.bytesDone, e.bytesTotal);
        chain = chain.then(() => appendDoneChunk(jpath, e.seq));
      },
    });
    bytesWritten = res.bytesWritten;
    await chain; // 确保进度落盘日志
  } catch (err) {
    endProgress();
    await chain.catch(() => {});
    throw err; // .part 与日志保留，供续传
  }
  endProgress();

  // 5. 端到端校验（有 contentId 才做）：装配文件必须字节等于上传物
  if (cid) {
    const got = await hashPlaintextFile(partPath, contentKey);
    if (got !== cid) {
      throw new BizhouError(
        "CHUNK",
        `下载文件 contentId 校验失败（数据不完整或损坏），未交付：${outPath}`,
      );
      // 注意：不 removeJournal、不 rename → 保留 .part 与日志供重试
    }
  }

  // 6. 原子改名落地 + 释放锁
  await rename(partPath, outPath);
  await removeJournal(jpath);
  return { status, bytesWritten };
}
```

> **实现者注意**：`stat`/`mkdir`/`rename`/`dirname` 均为 `commands.ts` 已有导入（`rename` 若未从 `node:fs/promises` 引入则补）。`warn`/`renderProgress`/`endProgress`/`BizhouError`/`Backend`/`Runtime` 均已在用。端到端校验失败分支必须**先于** rename/removeJournal 抛出。

- [ ] **Step 4: 改写 `cmdPull` 单文件分支走 `pullOneBundle`**

`cmdPull`（`packages/cli/src/commands.ts:598-613`）单文件分支替换为：

```ts
  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const { meta } = await readResourceMeta(mk, backend.bundleStore(fullId, dir));
  const outPath = downloadLocalPath(rt.fileRoot, opts.out ?? dir, meta.name);
  const contentKey = deriveContentKey(mk);
  info(`下载还原：${fullId} → ${outPath}（${formatBytes(meta.size)}）`);
  const r = await pullOneBundle(rt, backend, mk, contentKey, fullId, dir, outPath, opts);
  if (r.status === "skipped-dup" || r.status === "locked") return;
  ok(`已还原${r.status === "resumed" ? "（续传）" : ""} ${formatBytes(r.bytesWritten)} → ${outPath}`);
```

`cmdPull` 的 `opts` 类型增 `force?: boolean`。

- [ ] **Step 5: CLI flag + HELP（`index.ts`）**

`pull` 分支解析 `--force`（布尔）传入 `cmdPull`。HELP 的 pull 行更新：

```
  pull <id|云端目录> [-r] [--out <dir>] [--force]   还原到文件根下（--force 无视幂等/在飞锁强制下载）
```

- [ ] **Step 6: 运行测试 + 全量回归**

Run: `bun test packages/cli/test/pull-idempotency.test.ts && bun test`
Expected: 6 新测试 PASS；无回归。

- [ ] **Step 7: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src packages/cli/test/pull-idempotency.test.ts`

```bash
git add packages/cli/src packages/cli/test/pull-idempotency.test.ts
git commit -m "feat(cli): pull 集成 幂等/在飞锁/分片续传 + 端到端 contentId 校验 + 原子落地 + --force"
```

---

### Task 3: 递归 pull 集成（`pull -r` 复用 pullOneBundle）

**Files:**
- Modify: `packages/cli/src/commands.ts`（`cmdPull` 递归分支逐 bundle 改调 `pullOneBundle`）
- Test: `packages/cli/test/pull-recursive-idempotency.test.ts`

**Interfaces:**
- Consumes: `pullOneBundle`（Task 2）、`walkBundlesUnder`。

- [ ] **Step 1: 写失败测试** `packages/cli/test/pull-recursive-idempotency.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makePullFixture } from "./helpers/memory-fixture.ts";

describe("pull -r 幂等", () => {
  test("整树第二次 pull → 全部 skipped-dup，不重复下载", async () => {
    const fx = await makePullFixture();
    try {
      // 造两个不同目录下的 bundle
      const a = await fx.packBundle(Buffer.alloc(120, 1), { dir: "/工作" });
      const b = await fx.packBundle(Buffer.alloc(90, 2), { dir: "/工作/子" });

      const first = await fx.pullRecursive("/工作");
      const second = await fx.pullRecursive("/工作");

      expect(first.restored).toBe(2);
      expect(second.skipped).toBe(2);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
```

> 夹具增 `pullRecursive(startDir)`：`walkBundlesUnder` 收集 bundle → 逐个算 `outPath=downloadLocalPath(fileRoot, b.dir, meta.name)` → `pullOneBundle` → 统计 restored/skipped/locked。`packBundle` 增可选 `dir` 参数落到指定云端目录。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/pull-recursive-idempotency.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改写 `cmdPull` 递归分支**

`cmdPull` 递归分支（`packages/cli/src/commands.ts:572-595`）循环体替换为逐 bundle 调 `pullOneBundle`：

```ts
  if (opts.recursive) {
    const startDir = normalizeCloudPath(id);
    const bundles = await walkBundlesUnder(backend, startDir);
    if (bundles.length === 0) {
      info(`（空）云端目录下无资源：${startDir}`);
      return;
    }
    const contentKey = deriveContentKey(mk);
    let restored = 0;
    let skipped = 0;
    for (const b of bundles) {
      const { meta } = await readResourceMeta(mk, backend.bundleStore(b.id, b.dir));
      const outPath = downloadLocalPath(rt.fileRoot, b.dir, meta.name);
      info(`下载还原：${b.id} → ${outPath}（${formatBytes(meta.size)}）`);
      const r = await pullOneBundle(rt, backend, mk, contentKey, b.id, b.dir, outPath, opts);
      if (r.status === "skipped-dup") skipped++;
      else if (r.status === "locked") {
        /* 跳过，不计 */
      } else {
        restored++;
        ok(`已还原${r.status === "resumed" ? "（续传）" : ""} ${formatBytes(r.bytesWritten)} → ${outPath}`);
      }
    }
    ok(`整树还原完成：还原 ${restored}，跳过（已存在）${skipped}，共 ${bundles.length} 个 → ${rt.fileRoot}`);
    return;
  }
```

- [ ] **Step 4: 运行测试 + 全量回归**

Run: `bun test packages/cli/test/pull-recursive-idempotency.test.ts && bun test`
Expected: 全绿。

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/commands.ts packages/cli/test/pull-recursive-idempotency.test.ts`

```bash
git add packages/cli/src/commands.ts packages/cli/test/pull-recursive-idempotency.test.ts
git commit -m "feat(cli): pull -r 复用 pullOneBundle，整树幂等/续传/锁一致"
```

---

## 收尾（所有任务后）

- [ ] 全量 `bun test` + `pnpm run typecheck` + `npx biome check .` + `pnpm run build` 全绿。
- [ ] 更新 `.claude/current-sprint.md`、`.claude/module-spec-registry.md`（decryptChunksToFile 续传、pullOneBundle）、`.claude/test-registry.md`（decrypt-resume / pull-idempotency / pull-recursive-idempotency）、`.claude/sprint-plan.md`（Phase 3 · S2 完成）。
- [ ] 交由人工按 git flow 处理（本计划不 push）。

## 自审记录

- **Spec 覆盖**：下载幂等（T2 步骤1）/ 在飞锁（T2 步骤2）/ 分片续传（T1 decrypt skip + T2 .part/日志）/ 临时文件原子落地（T2 步骤6）/ 端到端校验兜底（T2 步骤5）/ 递归一致（T3）。
- **类型一致**：`pullOneBundle` 的 status 联合类型在 T2/T3 一致；`UnpackOptions.skip`/`DecryptFileOptions.skip` 均 `readonly number[]`；`JournalEntry` 可选字段改动不破坏 S1 上传（上传仍写全字段，校验对存在字段仍严格）。
- **无占位符**：各步含完整测试与实现代码；夹具需扩展的能力逐项列出。
- **安全**：GCM/sha256 失败即抛；端到端 contentId 校验不过绝不 rename 交付；下载日志无密钥；`.part` + 原子 rename 保证最终文件要么完整正确要么不存在。
- **续传正确性的双保险**：逐片密文 sha256（下载即校验）+ 装配后端到端 contentId（防日志/flush 竞态导致的"跳过了实际缺失的片"）。对无 contentId 的旧 bundle 退化为仅前者。
```
