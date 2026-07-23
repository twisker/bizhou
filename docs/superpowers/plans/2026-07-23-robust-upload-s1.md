# S1 · 健壮上传 实现计划（并发 + 续传 + 幂等）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bz push` 具备片内 4MB 并发上传、中断续传、内容级幂等（去重跳过 + 在飞锁），且 manifest 本地缓存消除去重扫描的重复网络拉取。

**Architecture:** 新增 3 个纯核心模块（`content` 内容身份 / `journal` 上传日志兼锁与续传状态 / `cache` manifest 缓存）；`BaiduClient.uploadPart` 串行 4MB 分片改限流池并发 + AbortController fail-fast；CLI 侧把预哈希→去重→锁/续传→打包串成一个 `pushOneFile` helper，`cmdPush` 与 `cmdPushRecursive` 共用。

**Tech Stack:** TypeScript + Bun 测试（`bun:test`），核心库仅用 `node:` 内置（`hkdfSync`/`createHmac`/`AbortController`）。

**Spec:** `docs/superpowers/specs/2026-07-23-robust-upload-download-design.md`

## Global Constraints

- 核心库 `@bizhou/core` **不得用 Bun 专有 API**，须在 Node LTS 等价运行；**零新增外部运行时依赖**（只 `node:` 内置）。
- 核心库**只发事件、绝不 print**；**绝不读时钟**（`now`/`startedAt`/`pid` 由 CLL 注入）。
- **contentId 只存进加密的 `encMeta`**，绝不明文进 manifest 顶层、云端、日志或缓存文件。
- 日志/缓存文件**不得含任何密钥/凭证**（只存 bundleId/seq/pid/时间戳/加密态 manifest）。
- 任何解密路径 GCM 校验失败**即抛错**，绝不静默返回损坏数据；保持**字节级往返一致**。
- 并发度 clamp 到 **[1,16]，默认 4**。
- 版本号由 pre-commit 的 `scripts/bump-version.sh` 自动处理，任务内**不手改** VERSION/package.json 版本。
- 每个逻辑分片的续传粒度 = 完成 `create` 的逻辑分片 seq；片内 4MB 续传交给百度 `precreate.blocksToUpload` 幂等兜底。

---

### Task 1: contentId 内容身份底座

**Files:**
- Create: `packages/core/src/content/index.ts`
- Test: `packages/core/test/content.test.ts`
- Modify: `packages/core/src/bundle/index.ts:44-50`（`ResourceMeta` 增 `contentId?`）
- Modify: `packages/core/src/resource/index.ts:30-48,68-73`（`PackOptions.contentId` → `meta.contentId`）
- Modify: `packages/core/src/index.ts:19`（导出 `content`）

**Interfaces:**
- Produces:
  - `deriveContentKey(mk: Buffer): Buffer` — 从 MK 经 HKDF-SHA256（info=`"bizhou-content-id"`）派生 32B 内容密钥。
  - `hashPlaintextBuffer(data: Buffer, contentKey: Buffer): string` — HMAC-SHA256(contentKey, data) 的 hex。
  - `hashPlaintextFile(filePath: string, contentKey: Buffer): Promise<string>` — 流式版本，结果与 buffer 版一致。
  - `ResourceMeta.contentId?: string`；`PackOptions.contentId?: string`。

- [ ] **Step 1: 写失败测试** `packages/core/test/content.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey, hashPlaintextBuffer, hashPlaintextFile } from "../src/content/index.ts";

describe("contentId 内容身份", () => {
  const mkA = Buffer.alloc(32, 1);
  const mkB = Buffer.alloc(32, 2);

  test("同明文同 MK → 同 contentId；不同 MK → 不同（带密钥）", () => {
    const data = Buffer.from("hello bizhou");
    const idA1 = hashPlaintextBuffer(data, deriveContentKey(mkA));
    const idA2 = hashPlaintextBuffer(data, deriveContentKey(mkA));
    const idB = hashPlaintextBuffer(data, deriveContentKey(mkB));
    expect(idA1).toBe(idA2);
    expect(idA1).not.toBe(idB);
    expect(idA1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("流式 hashPlaintextFile 与一次性 hashPlaintextBuffer 一致（含空文件）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-content-"));
    try {
      const key = deriveContentKey(mkA);
      const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab); // 跨多次读
      const bigPath = join(dir, "big.bin");
      await writeFile(bigPath, big);
      expect(await hashPlaintextFile(bigPath, key)).toBe(hashPlaintextBuffer(big, key));

      const emptyPath = join(dir, "empty.bin");
      await writeFile(emptyPath, Buffer.alloc(0));
      expect(await hashPlaintextFile(emptyPath, key)).toBe(hashPlaintextBuffer(Buffer.alloc(0), key));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/core/test/content.test.ts`
Expected: FAIL（`Cannot find module '../src/content/index.ts'`）

- [ ] **Step 3: 实现** `packages/core/src/content/index.ts`

```ts
/**
 * 内容身份（contentId）：用于上传/下载幂等去重的"明文内容指纹"。
 *
 * contentId = HMAC-SHA256(contentKey, 明文)，contentKey = HKDF-SHA256(MK, info="bizhou-content-id")。
 * 带密钥 → 不是裸明文哈希，不同账号（不同 MK）对同一明文得到不同指纹，跨账号不可关联；
 * 仅存进加密的 encMeta（绝不明文暴露给云端），故对隐私零泄露。
 * 定义在明文上 → 同文件带不带 --compress 是同一身份。
 */

import { createHmac, hkdfSync } from "node:crypto";
import { open } from "node:fs/promises";

const CONTENT_ID_INFO = Buffer.from("bizhou-content-id", "utf8");
const READ_BUF_BYTES = 1024 * 1024; // 1MB 流式读块

/** 从 MK 派生 32B 内容密钥（域分离，避免与其他用途密钥重用）。 */
export function deriveContentKey(mk: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", mk, Buffer.alloc(0), CONTENT_ID_INFO, 32));
}

/** HMAC-SHA256(contentKey, data) 的 hex 摘要。 */
export function hashPlaintextBuffer(data: Buffer, contentKey: Buffer): string {
  return createHmac("sha256", contentKey).update(data).digest("hex");
}

/** 流式计算整文件的 contentId（内存与文件大小解耦）。 */
export async function hashPlaintextFile(filePath: string, contentKey: Buffer): Promise<string> {
  const hmac = createHmac("sha256", contentKey);
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_BUF_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_BUF_BYTES, position);
      if (bytesRead === 0) break;
      hmac.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hmac.digest("hex");
}
```

- [ ] **Step 4: 接线 `ResourceMeta` 与 `PackOptions`**

在 `packages/core/src/bundle/index.ts` 的 `ResourceMeta` 增字段（`sealMeta`/`openMeta` 走 JSON，无需改签名；`openMeta` 的必需字段校验不变，`contentId` 为可选）：

```ts
export interface ResourceMeta {
  readonly name: string; // 原文件名
  readonly size: number; // 原始明文总字节数
  readonly mtime?: string; // ISO8601，可选
  readonly contentType?: string;
  readonly contentId?: string; // 明文内容指纹（HMAC，仅存加密 encMeta）
}
```

在 `packages/core/src/resource/index.ts`：`PackOptions` 增 `readonly contentId?: string;`，并在构造 `meta` 时带上：

```ts
  const meta: ResourceMeta = {
    name: opts.name ?? basename(opts.filePath),
    size: opts.fileSize,
    ...(opts.mtime ? { mtime: opts.mtime } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.contentId ? { contentId: opts.contentId } : {}),
  };
```

在 `packages/core/src/index.ts` 增 `export * from "./content/index.ts";`

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test packages/core/test/content.test.ts`
Expected: PASS（2 测试）

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/content packages/core/test/content.test.ts packages/core/src/bundle/index.ts packages/core/src/resource/index.ts packages/core/src/index.ts`

```bash
git add packages/core/src/content packages/core/test/content.test.ts packages/core/src/bundle/index.ts packages/core/src/resource/index.ts packages/core/src/index.ts
git commit -m "feat(core): contentId 内容身份底座（HKDF(MK)+HMAC 明文，存加密 encMeta）"
```

---

### Task 2: uploadPart 限流池并发 + fail-fast

**Files:**
- Modify: `packages/core/src/baidu/client.ts`（`HttpRequestInit.signal`、`withRetry` 支持 signal、`uploadSlice` 透传 signal、`BaiduClient` 增 `uploadConcurrency`、`uploadPart` 并发池）
- Modify: `packages/cli/src/runtime.ts`（http 适配器透传 signal）
- Test: `packages/core/test/upload-concurrency.test.ts`

**Interfaces:**
- Consumes: `withRetry`（Task 内改造）。
- Produces:
  - `HttpRequestInit.signal?: AbortSignal`
  - `BaiduClient` 构造 opts 增 `uploadConcurrency?: number`（默认 4，clamp[1,16]）。
  - `uploadPart` 行为：`blocksToUpload` 内的分片以 ≤concurrency 并发上传；任一分片重试耗尽 → abort 在飞、不 `create`、抛错。

- [ ] **Step 1: 写失败测试** `packages/core/test/upload-concurrency.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { BaiduClient, type HttpClient, type HttpResponse } from "../src/baidu/client.ts";

function jsonRes(obj: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** 造一个 4 个 4MB 分片的 buffer（16MB+1，凑 5 片以便观察并发）。 */
const DATA = Buffer.alloc(4 * 1024 * 1024 * 4 + 1, 7);

describe("uploadPart 并发", () => {
  test("片内 4MB 分片以 ≤concurrency 并发上传，且全部上传", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const uploaded = new Set<string>();
    const http: HttpClient = async (url, init) => {
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "U", block_list: [] });
      if (url.includes("superfile2")) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
        const seq = new URL(url).searchParams.get("partseq");
        uploaded.add(seq ?? "");
        return jsonRes({ md5: `m${seq}` });
      }
      if (url.includes("create")) return jsonRes({ errno: 0, fs_id: 123 });
      return jsonRes({ errno: 0 });
    };
    const client = new BaiduClient({ appKey: "k", secretKey: "s" }, "tok", http, {
      uploadConcurrency: 3,
    });
    await client.uploadPart("/apps/bizhou/x/000.part", DATA);
    expect(maxInflight).toBeGreaterThan(1); // 确有并发
    expect(maxInflight).toBeLessThanOrEqual(3); // 不超过池上限
    expect(uploaded.size).toBe(5); // 5 片全传
  });

  test("fail-fast：某分片重试耗尽 → 抛错且不调 create", async () => {
    let createCalled = false;
    const http: HttpClient = async (url) => {
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "U", block_list: [] });
      if (url.includes("superfile2")) {
        const seq = new URL(url).searchParams.get("partseq");
        if (seq === "2") throw new Error("boom slice 2");
        return jsonRes({ md5: `m${seq}` });
      }
      if (url.includes("create")) {
        createCalled = true;
        return jsonRes({ errno: 0, fs_id: 1 });
      }
      return jsonRes({ errno: 0 });
    };
    const client = new BaiduClient({ appKey: "k", secretKey: "s" }, "tok", http, {
      uploadConcurrency: 3,
      maxRetries: 2,
    });
    await expect(client.uploadPart("/apps/bizhou/x/000.part", DATA)).rejects.toThrow(/boom slice 2/);
    expect(createCalled).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/upload-concurrency.test.ts`
Expected: FAIL（当前串行，`maxInflight` 恒为 1；且构造 opts 无 `uploadConcurrency`）

- [ ] **Step 3: `HttpRequestInit` 增 signal + 适配器透传**

`packages/core/src/baidu/client.ts` 的 `HttpRequestInit`：

```ts
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | FormData;
  signal?: AbortSignal;
}
```

`packages/cli/src/runtime.ts` 的 `httpAdapter` 不需改（`init` 原样传给 `fetch`，`fetch` 认 `signal`）——确认 `fetch(url, init as RequestInit)` 已把 signal 带上；若 TS 报错则显式：`fetch(url, init as unknown as RequestInit)`（保持现状即可）。

- [ ] **Step 4: `withRetry` 支持 signal（aborted 不再重试）**

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    tries?: number;
    baseMs?: number;
    onRetry?: (attempt: number, err: unknown) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    if (opts.signal?.aborted) throw lastErr ?? new BizhouError("BAIDU", "上传已取消");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err; // 已取消：不再退避重试
      if (i < tries - 1) {
        opts.onRetry?.(i + 1, err);
        await sleep(baseMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}
```

- [ ] **Step 5: `uploadSlice` 透传 signal**

签名加可选 `signal`，并入 http：

```ts
  async uploadSlice(
    path: string,
    uploadid: string,
    partseq: number,
    slice: Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${PCS_SUPERFILE}?${form({
      method: "upload",
      access_token: this.accessToken,
      type: "tmpfile",
      path,
      uploadid,
      partseq: String(partseq),
    })}`;
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(slice)]), "part");
    const res = await this.http(url, { method: "POST", body: fd, signal });
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.md5 !== "string") {
      throw new BizhouError("BAIDU", `superfile2 分片 ${partseq} 未返回 md5`);
    }
    return data.md5;
  }
```

- [ ] **Step 6: `BaiduClient` 增 `uploadConcurrency` + `uploadPart` 并发池**

构造函数：

```ts
export class BaiduClient {
  private readonly maxRetries: number;
  private readonly uploadConcurrency: number;

  constructor(
    readonly _config: OAuthConfig,
    private accessToken: string,
    private readonly http: HttpClient,
    opts: { maxRetries?: number; uploadConcurrency?: number } = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.uploadConcurrency = Math.min(16, Math.max(1, opts.uploadConcurrency ?? 4));
  }
```

`uploadPart` 的分片循环替换为限流池：

```ts
  async uploadPart(
    path: string,
    data: Buffer,
    onSlice?: (partseq: number, total: number) => void,
  ): Promise<{ fsId?: number }> {
    const slices = sliceTransfer(data);
    const blockMd5 = slices.map(md5hex);
    const { uploadid, blocksToUpload } = await this.precreate(path, data.length, blockMd5);
    // 仅上传仍需的分片（断点续传 / 秒传时可能为空）。
    const need = blocksToUpload.filter((i) => i >= 0 && i < slices.length);
    const total = slices.length;

    const ac = new AbortController();
    let nextK = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (ac.signal.aborted) return;
        const k = nextK++;
        if (k >= need.length) return;
        const i = need[k]!;
        // 单片幂等：同 partseq+uploadid 可重传；aborted 时 withRetry 不再重试。
        await withRetry(() => this.uploadSlice(path, uploadid, i, slices[i]!, ac.signal), {
          tries: this.maxRetries,
          signal: ac.signal,
        });
        onSlice?.(i, total);
      }
    };

    const poolN = Math.min(this.uploadConcurrency, Math.max(1, need.length));
    try {
      await Promise.all(Array.from({ length: poolN }, () => worker()));
    } catch (err) {
      ac.abort(); // fail-fast：取消在飞分片
      throw err; // 不调 create，逻辑分片视为未完成
    }
    return this.create(path, data.length, uploadid, blockMd5);
  }
```

- [ ] **Step 7: 运行测试确认通过 + 全量回归**

Run: `bun test packages/core/test/upload-concurrency.test.ts && bun test`
Expected: 新测试 PASS；既有测试无回归。

- [ ] **Step 8: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/baidu/client.ts packages/core/test/upload-concurrency.test.ts`

```bash
git add packages/core/src/baidu/client.ts packages/core/test/upload-concurrency.test.ts packages/cli/src/runtime.ts
git commit -m "feat(core): uploadPart 4MB 分片限流池并发 + AbortController fail-fast"
```

---

### Task 3: 上传日志模块（锁 + 续传状态）

**Files:**
- Create: `packages/core/src/journal/index.ts`
- Test: `packages/core/test/journal.test.ts`
- Modify: `packages/core/src/index.ts`（导出 journal）

**Interfaces:**
- Produces（核心库不读时钟：`now`/`startedAt`/`pid`/`pidAlive` 均由调用方注入）：
  - `type JournalKind = "upload" | "download"`
  - `interface JournalEntry { bundleId: string; cloudDir: string; contentId: string; doneChunks: number[]; totalChunks: number; startedAt: string; pid: number; }`
  - `journalPath(keyRoot: string, kind: JournalKind, contentId: string, destKey: string): string`
  - `readJournal(path): Promise<JournalEntry | null>`（不存在/损坏 → null）
  - `writeJournal(path, entry): Promise<void>`（原子：写 tmp 再 rename）
  - `appendDoneChunk(path, seq): Promise<void>`（读改写，seq 去重）
  - `removeJournal(path): Promise<void>`
  - `isLockAlive(entry, opts: { ttlMs: number; now: number; pidAlive: boolean }): boolean`

- [ ] **Step 1: 写失败测试** `packages/core/test/journal.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDoneChunk,
  isLockAlive,
  type JournalEntry,
  journalPath,
  readJournal,
  removeJournal,
  writeJournal,
} from "../src/journal/index.ts";

const entry = (): JournalEntry => ({
  bundleId: "abc123",
  cloudDir: "/工作",
  contentId: "f".repeat(64),
  doneChunks: [],
  totalChunks: 3,
  startedAt: "2026-07-23T00:00:00.000Z",
  pid: 4242,
});

describe("上传日志", () => {
  test("journalPath 同 contentId+目的地稳定、不同目的地相异，且不泄露明文身份到路径外", () => {
    const root = "/root";
    const p1 = journalPath(root, "upload", "a".repeat(64), "/工作");
    const p2 = journalPath(root, "upload", "a".repeat(64), "/工作");
    const p3 = journalPath(root, "upload", "a".repeat(64), "/别处");
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toContain(".uploads");
  });

  test("write→read→append→read→remove 往返；doneChunks 去重", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl-"));
    try {
      const p = journalPath(dir, "upload", entry().contentId, entry().cloudDir);
      await writeJournal(p, entry());
      let got = await readJournal(p);
      expect(got?.bundleId).toBe("abc123");

      await appendDoneChunk(p, 0);
      await appendDoneChunk(p, 1);
      await appendDoneChunk(p, 0); // 重复
      got = await readJournal(p);
      expect(got?.doneChunks).toEqual([0, 1]);

      // 日志不得含明文 contentId 之外的敏感信息，且绝无密钥字段
      const raw = await readFile(p, "utf8");
      expect(raw).not.toMatch(/dek|mk|password|secret|token/i);

      await removeJournal(p);
      expect(await readJournal(p)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readJournal 对缺失/损坏返回 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl2-"));
    try {
      expect(await readJournal(join(dir, "nope.json"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isLockAlive：pid 存活→活；pid 死且超 TTL→死；pid 死但未超 TTL→活", () => {
    const e = entry(); // startedAt = 2026-07-23T00:00:00Z
    const t0 = Date.parse(e.startedAt);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 10_000, pidAlive: true })).toBe(true);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 120_000, pidAlive: false })).toBe(false);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 10_000, pidAlive: false })).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/journal.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/core/src/journal/index.ts`

```ts
/**
 * 上传/下载日志：一份本地 JSON 同时充当"在飞锁"与"续传状态"。
 * 键 = contentId@hash(目的地)；内容只含 bundleId/seq/pid/时间戳（绝无任何密钥）。
 * 核心库不读时钟：now/startedAt/pid/pidAlive 由 CLI 注入。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type JournalKind = "upload" | "download";

export interface JournalEntry {
  readonly bundleId: string;
  readonly cloudDir: string;
  readonly contentId: string;
  readonly doneChunks: number[];
  readonly totalChunks: number;
  readonly startedAt: string; // ISO8601，CLI 注入
  readonly pid: number; // CLI 注入
}

const KIND_DIR: Record<JournalKind, string> = { upload: ".uploads", download: ".downloads" };

/** 日志文件路径：<keyRoot>/<.uploads|.downloads>/<contentId>@<destHash>.json */
export function journalPath(
  keyRoot: string,
  kind: JournalKind,
  contentId: string,
  destKey: string,
): string {
  const destHash = createHash("sha256").update(destKey).digest("hex").slice(0, 16);
  return join(keyRoot, KIND_DIR[kind], `${contentId}@${destHash}.json`);
}

export async function readJournal(path: string): Promise<JournalEntry | null> {
  try {
    const raw = await readFile(path, "utf8");
    const e = JSON.parse(raw) as JournalEntry;
    if (typeof e.bundleId !== "string" || !Array.isArray(e.doneChunks)) return null;
    return e;
  } catch {
    return null; // 缺失或损坏
  }
}

export async function writeJournal(path: string, entry: JournalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), "utf8");
  await rename(tmp, path); // 原子替换
}

export async function appendDoneChunk(path: string, seq: number): Promise<void> {
  const e = await readJournal(path);
  if (!e) return; // 日志已被清理则无操作
  if (!e.doneChunks.includes(seq)) {
    e.doneChunks.push(seq);
    e.doneChunks.sort((a, b) => a - b);
    await writeJournal(path, e);
  }
}

export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** 锁是否仍活：拥有进程存活，或虽已死但距 startedAt 未超 TTL（防误判刚启动的并发）。 */
export function isLockAlive(
  entry: JournalEntry,
  opts: { ttlMs: number; now: number; pidAlive: boolean },
): boolean {
  if (opts.pidAlive) return true;
  return opts.now - Date.parse(entry.startedAt) < opts.ttlMs;
}
```

在 `packages/core/src/index.ts` 增 `export * from "./journal/index.ts";`

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/core/test/journal.test.ts`
Expected: PASS（4 测试）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/journal packages/core/test/journal.test.ts packages/core/src/index.ts`

```bash
git add packages/core/src/journal packages/core/test/journal.test.ts packages/core/src/index.ts
git commit -m "feat(core): 上传日志模块（锁+续传状态，核心不读时钟）"
```

---

### Task 4: manifest 缓存模块 + 失效钩子

**Files:**
- Create: `packages/core/src/cache/index.ts`
- Test: `packages/core/test/cache.test.ts`
- Modify: `packages/core/src/index.ts`（导出 cache）
- Modify: `packages/cli/src/commands.ts`（`cmdRename`/`cmdRm`/`cmdTrash` 成功后 `invalidateManifest`）

**Interfaces:**
- Produces:
  - `getCachedManifest(keyRoot: string, bundleId: string): Promise<string | null>`（原始 manifest JSON；缺失→null）
  - `putCachedManifest(keyRoot: string, bundleId: string, rawManifest: string): Promise<void>`
  - `invalidateManifest(keyRoot: string, bundleId: string): Promise<void>`
- Consumes: 无（纯 IO）。

- [ ] **Step 1: 写失败测试** `packages/core/test/cache.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCachedManifest,
  invalidateManifest,
  putCachedManifest,
} from "../src/cache/index.ts";

describe("manifest 缓存", () => {
  test("put→get 往返；invalidate 后未命中", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-cache-"));
    try {
      const raw = JSON.stringify({ bundleId: "deadbeef", encMeta: "BASE64ENC", chunks: [] });
      expect(await getCachedManifest(root, "deadbeef")).toBeNull();
      await putCachedManifest(root, "deadbeef", raw);
      expect(await getCachedManifest(root, "deadbeef")).toBe(raw);
      await invalidateManifest(root, "deadbeef");
      expect(await getCachedManifest(root, "deadbeef")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bundleId 作为单段校验：拒绝路径穿越键", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-cache2-"));
    try {
      await expect(putCachedManifest(root, "../evil", "{}")).rejects.toThrow();
      await expect(getCachedManifest(root, "../evil")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/cache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/core/src/cache/index.ts`

```ts
/**
 * manifest 本地缓存：消除去重扫描对目标目录各 bundle manifest 的重复网络拉取。
 * 只缓存"原始 manifest（encMeta 仍加密态）"，不缓存解出的 contentId → 不把明文内容身份落盘。
 * 键 = 不可变 bundleId；rename（改 encMeta）与 rm/trash（bundle 消失）需 invalidate，mv 不需。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNameSegment } from "../cloudpath/index.ts";

const CACHE_SUBDIR = join(".cache", "manifests");

function cacheFile(keyRoot: string, bundleId: string): string {
  assertNameSegment(bundleId); // 防 bundleId 含 ../ 逃逸缓存目录
  return join(keyRoot, CACHE_SUBDIR, `${bundleId}.json`);
}

export async function getCachedManifest(keyRoot: string, bundleId: string): Promise<string | null> {
  try {
    return await readFile(cacheFile(keyRoot, bundleId), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err; // 校验失败（穿越键）等仍抛出
  }
}

export async function putCachedManifest(
  keyRoot: string,
  bundleId: string,
  rawManifest: string,
): Promise<void> {
  const path = cacheFile(keyRoot, bundleId);
  await mkdir(join(keyRoot, CACHE_SUBDIR), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, rawManifest, "utf8");
  await rename(tmp, path);
}

export async function invalidateManifest(keyRoot: string, bundleId: string): Promise<void> {
  await rm(cacheFile(keyRoot, bundleId), { force: true });
}
```

> 说明：`getCachedManifest` 对穿越键要先触发 `assertNameSegment` 抛错——因 `cacheFile` 在 `readFile` 前调用，`../evil` 会在拼路径时即抛 `InvalidArgError`，不会被 ENOENT 分支吞掉。

在 `packages/core/src/index.ts` 增 `export * from "./cache/index.ts";`

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/core/test/cache.test.ts`
Expected: PASS（2 测试）

- [ ] **Step 5: CLI 失效钩子**

在 `packages/cli/src/commands.ts` 顶部从 `@bizhou/core` 引入 `invalidateManifest`。在以下命令**成功改动某 bundle 后**调用 `await invalidateManifest(rt.paths.dir, <bundleId>)`：
- `cmdRename`：改名的是 bundle（非目录）时，对该 bundleId 失效。
- `cmdRm` / `cmdTrash rm/clear`：删除的是 bundle 时，对该 bundleId 失效（clear 时对涉及的所有 bundleId 失效，或直接删除整个 `<keyRoot>/.cache/manifests` 目录——二选一，以简单为准）。

> 注意：这些命令当前按 id 前缀解析出 `bundleId`（`resolveBundle`）。在既有成功路径末尾加失效调用即可，不改变主流程。若某命令作用于目录而非 bundle，则跳过失效（目录不涉及 manifest 缓存）。

- [ ] **Step 6: 回归 + 类型 + lint + 提交**

Run: `bun test && pnpm run typecheck && npx biome check --write packages/core/src/cache packages/core/test/cache.test.ts packages/core/src/index.ts packages/cli/src/commands.ts`
Expected: 全绿。

```bash
git add packages/core/src/cache packages/core/test/cache.test.ts packages/core/src/index.ts packages/cli/src/commands.ts
git commit -m "feat(core): manifest 缓存模块（只存加密态）+ rename/rm/trash 失效钩子"
```

---

### Task 5: cmdPush 集成（预哈希 → 去重 → 锁/续传 → --force/--concurrency）

**Files:**
- Modify: `packages/cli/src/commands.ts`（新增 `pushOneFile` helper；`cmdPush` 改为调用它；新增 `findDuplicateBundle`、`resolveUploadConcurrency`、`pidAlive` 辅助）
- Modify: `packages/cli/src/runtime.ts`（`Runtime` 增 `uploadConcurrency`；`makeBackend`/`baiduClientForCurrent` 支持并发度覆盖）
- Modify: `packages/cli/src/index.ts`（`push` 增 `--force`、`--concurrency N`；HELP 更新）
- Test: `packages/cli/test/push-idempotency.test.ts`

**Interfaces:**
- Consumes: `deriveContentKey`/`hashPlaintextFile`（Task 1）、journal API（Task 3）、cache API（Task 4）、`packResource`（`skipExisting`/`contentId`）。
- Produces:
  - `pushOneFile(rt, backend, mk, contentKey, absFile, cloudDir, opts): Promise<{ bundleId: string; status: "uploaded" | "skipped-dup" | "locked" | "resumed" }>` —— 供 `cmdPush` 与 `cmdPushRecursive`（Task 6）共用的单文件上传内核。
  - `resolveUploadConcurrency(rt, flag?: number): number`（flag ?? config ?? 4，clamp[1,16]）。

**决策常量：** 锁 TTL = `UPLOAD_LOCK_TTL_MS = 30 * 60 * 1000`（30 分钟，覆盖大文件长传）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/push-idempotency.test.ts`

> 用内存后端与内存 vault 直接驱动 `pushOneFile`（不联网）。测试聚焦幂等/续传/锁三条路径。

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey } from "@bizhou/core";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

// helpers/memory-fixture.ts 造：内存 Backend（listDir/bundleStore 用 MemoryBundleStore 支撑）、
// 一个固定 MK、一个临时 keyRoot 作为 rt.paths.dir、并暴露 pushOneFile 所需的最小 rt。

describe("push 幂等/续传/锁（内存后端）", () => {
  test("去重：同内容第二次 push → skipped-dup，不新增 bundle", async () => {
    const fx = await makeMemoryFixture();
    try {
      const contentKey = deriveContentKey(fx.mk);
      const f = join(fx.tmp, "a.bin");
      await writeFile(f, Buffer.alloc(1024, 9));

      const r1 = await fx.pushOneFile(f, "/工作", {});
      expect(r1.status).toBe("uploaded");
      const r2 = await fx.pushOneFile(f, "/工作", {});
      expect(r2.status).toBe("skipped-dup");
      expect(await fx.countBundles("/工作")).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("--force：绕过去重仍上传", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "b.bin");
      await writeFile(f, Buffer.alloc(2048, 3));
      await fx.pushOneFile(f, "/x", {});
      const r = await fx.pushOneFile(f, "/x", { force: true });
      expect(r.status).toBe("uploaded");
      expect(await fx.countBundles("/x")).toBe(2);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("在飞锁：预置存活日志 → 同内容 push 得 locked，不上传", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "c.bin");
      await writeFile(f, Buffer.alloc(1000, 1));
      await fx.writeLiveLock(f, "/y"); // startedAt=now, pid=process.pid（存活）
      const r = await fx.pushOneFile(f, "/y", {});
      expect(r.status).toBe("locked");
      expect(await fx.countBundles("/y")).toBe(0);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("续传：崩溃残留日志（doneChunks=[0]）→ resumed，skipExisting 生效", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "d.bin");
      // 造 3 个逻辑分片（chunkSize 小）
      await writeFile(f, Buffer.alloc(300, 7));
      const seen = await fx.writeStaleLockWithChunk0(f, "/z", { chunkSize: 100 });
      const r = await fx.pushOneFile(f, "/z", { chunk: "100" });
      expect(r.status).toBe("resumed");
      expect(r.bundleId).toBe(seen.bundleId); // 复用 bundleId
      expect(seen.putChunkCalls).not.toContain(0); // 第 0 片被 skipExisting 跳过
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
```

> **实现者注意**：`test/helpers/memory-fixture.ts` 是本任务的一部分，需一并创建。它封装：临时 `keyRoot`、固定 32B MK、一个内存 `Backend`（`listDir` 返回已建 bundle、`bundleStore` 返回记录 `putChunk` 调用的 `MemoryBundleStore` 包装）、以及一个只含 `pushOneFile` 所需字段的最小 `rt`（`{ paths: { dir: keyRoot }, uploadConcurrency: 4, now: () => Date.now() }`）。`writeLiveLock`/`writeStaleLockWithChunk0` 用 `journalPath`+`writeJournal` 预置日志（stale 用过去的 `startedAt` 且 `pid` 取一个不存在的 pid，如 `2 ** 30`）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/push-idempotency.test.ts`
Expected: FAIL（`pushOneFile`/fixture 不存在）

- [ ] **Step 3: runtime 支持并发度**

`packages/cli/src/runtime.ts`：
- 读 config.json 时一并读 `uploadConcurrency`：`const cfg = JSON.parse(...) as { fileRoot?: string; uploadConcurrency?: number };`
- `Runtime` 接口增 `readonly uploadConcurrency: number;`；`createRuntime` 返回对象里 `uploadConcurrency: Math.min(16, Math.max(1, cfg?.uploadConcurrency ?? 4))`（cfg 读取失败则 4）。
- `baiduClientForCurrent(rt, concurrency?)` 增可选并发度参数：`return new BaiduClient(rt.oauthConfig(), tokens.accessToken, rt.http, { uploadConcurrency: concurrency ?? rt.uploadConcurrency });`
- `makeBackend(rt, localDir, concurrency?)` 透传：`return new BaiduBackend(await baiduClientForCurrent(rt, concurrency));`（`LocalBackend` 分支不变）。

- [ ] **Step 4: 实现 `pushOneFile` 与辅助（`commands.ts`）**

新增（含从 `@bizhou/core` 引入 `deriveContentKey, hashPlaintextFile, journalPath, readJournal, writeJournal, removeJournal, isLockAlive, getCachedManifest, putCachedManifest, unwrapDek, openMeta, parseManifest`）：

```ts
const UPLOAD_LOCK_TTL_MS = 30 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 不发信号，仅探测存活
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // 存在但无权 → 视为存活
  }
}

export function resolveUploadConcurrency(rt: Runtime, flag?: number): number {
  const v = flag ?? rt.uploadConcurrency ?? 4;
  return Math.min(16, Math.max(1, Math.floor(v)));
}

/** 扫目标云端目录，返回与 targetContentId 相同的已完成 bundleId（走 manifest 缓存），无则 null。 */
async function findDuplicateBundle(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  cloudDir: string,
  targetContentId: string,
): Promise<string | null> {
  const { bundles } = await backend.listDir(cloudDir);
  for (const b of bundles) {
    let raw = await getCachedManifest(rt.paths.dir, b.id);
    if (raw === null) {
      try {
        raw = await backend.bundleStore(b.id, cloudDir).getManifest();
      } catch {
        continue; // 该 bundle 尚不完整（无 manifest）→ 跳过
      }
      await putCachedManifest(rt.paths.dir, b.id, raw);
    }
    try {
      const m = parseManifest(raw);
      const meta = openMeta(unwrapDek(mk, m.wrappedKey), m.encMeta);
      if (meta.contentId === targetContentId) return b.id;
    } catch {
      continue; // 非本 vault 或损坏 → 跳过
    }
  }
  return null;
}

interface PushOneOpts {
  chunk?: string;
  compress?: boolean;
  noSplit?: boolean;
  name?: string;
  preview?: boolean;
  force?: boolean;
}

/** 单文件上传内核：预哈希 → 去重 → 锁/续传 → packResource。cmdPush 与递归 push 共用。 */
async function pushOneFile(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  absFile: string,
  cloudDir: string,
  opts: PushOneOpts,
): Promise<{ bundleId: string; status: "uploaded" | "skipped-dup" | "locked" | "resumed" }> {
  const st = await stat(absFile);
  const contentId = await hashPlaintextFile(absFile, contentKey);
  const jpath = journalPath(rt.paths.dir, "upload", contentId, cloudDir);

  // 1. 去重（--force 跳过）
  if (!opts.force) {
    const dup = await findDuplicateBundle(rt, backend, mk, cloudDir, contentId);
    if (dup) {
      warn(`目标已有相同文件（${c.bold(dup)}），跳过：${absFile}`);
      return { bundleId: dup, status: "skipped-dup" };
    }
  }

  // 2. 查日志：锁 or 续传 or 新建
  const existing = await readJournal(jpath);
  let bundleId: string;
  let skipExisting: number[] = [];
  let status: "uploaded" | "resumed" = "uploaded";
  if (existing) {
    const alive = isLockAlive(existing, {
      ttlMs: UPLOAD_LOCK_TTL_MS,
      now: rt.now(),
      pidAlive: pidAlive(existing.pid),
    });
    if (alive && !opts.force) {
      warn(`同文件正在上传至该目录，已结束：${absFile}`);
      return { bundleId: existing.bundleId, status: "locked" };
    }
    // 崩溃残留（或 --force 复用）→ 续传
    bundleId = existing.bundleId;
    skipExisting = existing.doneChunks;
    status = "resumed";
  } else {
    bundleId = generateBundleId();
  }

  const chunkSize = opts.noSplit
    ? Math.max(st.size, 1)
    : opts.chunk
      ? parseSize(opts.chunk)
      : DEFAULT_CHUNK_SIZE;
  const totalChunks = Math.max(1, Math.ceil(st.size / chunkSize));

  if (cloudDir !== "/") await backend.mkdir(cloudDir);
  const store = backend.bundleStore(bundleId, cloudDir);

  // 3. 写日志（上锁）
  await writeJournal(jpath, {
    bundleId,
    cloudDir,
    contentId,
    doneChunks: skipExisting,
    totalChunks,
    startedAt: new Date(rt.now()).toISOString(),
    pid: process.pid,
  });

  let preview: { kind: "video" | "audio" | "image"; data: Buffer } | undefined;
  if (opts.preview) {
    const p = await generatePreview(absFile);
    if (p) preview = p;
    else warn("未生成预览（非媒体类型或 ffmpeg 不可用），继续上传原文件。");
  }

  try {
    await packResource({
      filePath: absFile,
      fileSize: st.size,
      mk,
      bundleId,
      createdAt: new Date(rt.now()).toISOString(),
      chunkSize,
      compression: opts.compress ? "gzip" : "none",
      store,
      name: opts.name ?? basename(absFile),
      mtime: st.mtime.toISOString(),
      contentId,
      preview,
      skipExisting,
      onProgress: (e) => {
        renderProgress("加密", e.bytesDone, e.bytesTotal);
        // 逻辑分片粒度记录续传进度（encrypt 事件在该片 putChunk 之后触发）
        void appendDoneChunk(jpath, e.seq);
      },
    });
  } catch (err) {
    endProgress();
    throw err; // 日志保留（doneChunks 已记），供下次续传
  }
  endProgress();
  await removeJournal(jpath); // 成功 → 释放锁
  return { bundleId, status };
}
```

> **实现者注意**：
> - `appendDoneChunk` 在 `onProgress` 里 fire-and-forget（`void`）；但为保证"最后一片写完前日志已含前序 seq"，改为在 `onProgress` 中 `await`——若 `onProgress` 签名不支持 async，则用一个串行队列（`p = p.then(() => appendDoneChunk(...))`）避免竞态。以简单正确为先：把 `onProgress` 内改为同步入队、`packResource` 后 `await` 该队列。
> - `warn`/`c`/`renderProgress`/`endProgress`/`generatePreview`/`parseSize`/`stat`/`basename`/`generateBundleId`/`DEFAULT_CHUNK_SIZE` 均为 `commands.ts` 已有导入或本地符号；`Backend` 类型从 `@bizhou/core` 引入（若尚未）。

- [ ] **Step 5: 改写 `cmdPush` 走 `pushOneFile`**

`cmdPush` 单文件分支（`packages/cli/src/commands.ts:263-307`）替换为：

```ts
  if (!st.isFile()) throw new BizhouError("INVALID_ARG", `不是文件：${filePath}`);
  const mk = await rt.resolveMk(opts);
  const contentKey = deriveContentKey(mk);
  const cloudDir = opts.to
    ? normalizeCloudPath(opts.to)
    : defaultUploadCloudDir(resolve(filePath), rt.fileRoot);
  const backend = await makeBackend(rt, opts.local, resolveUploadConcurrency(rt, opts.concurrency));
  info(`加密上传：${filePath}（${formatBytes(st.size)}）→ ${cloudDir}`);
  const r = await pushOneFile(rt, backend, mk, contentKey, resolve(filePath), cloudDir, opts);
  if (r.status === "skipped-dup" || r.status === "locked") return r.bundleId;
  ok(`已上传${r.status === "resumed" ? "（续传）" : ""}。资源 ID：${c.bold(r.bundleId)}`);
  out(r.bundleId);
  return r.bundleId;
```

`cmdPush` 的 `opts` 类型增 `force?: boolean; concurrency?: number;`。

- [ ] **Step 6: CLI flag 解析 + HELP（`index.ts`）**

`push` 分支解析 `--force`（布尔）与 `--concurrency <n>`（整数）；传入 `cmdPush` 的 opts。HELP 中 push 行更新：

```
  push <path> [-r] [--chunk 100MB] [--compress] [--no-split] [--name <n>] [--preview] [--to <云端目录>] [--force] [--concurrency N]
                          （--force 无视去重/在飞锁强制上传；--concurrency 片内并发数，默认 4，范围 1-16）
```

- [ ] **Step 7: 运行测试 + 全量回归**

Run: `bun test packages/cli/test/push-idempotency.test.ts && bun test`
Expected: 新测试 PASS；无回归。

- [ ] **Step 8: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src packages/cli/test/push-idempotency.test.ts`

```bash
git add packages/cli/src packages/cli/test/push-idempotency.test.ts
git commit -m "feat(cli): push 集成 内容去重/在飞锁/续传 + --force/--concurrency"
```

---

### Task 6: 递归 push 集成（`push -r` 复用 pushOneFile）

**Files:**
- Modify: `packages/cli/src/commands.ts`（`cmdPushRecursive` 逐文件改调 `pushOneFile`）
- Test: `packages/cli/test/push-recursive-idempotency.test.ts`

**Interfaces:**
- Consumes: `pushOneFile`（Task 5）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/push-recursive-idempotency.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

describe("push -r 幂等", () => {
  test("整树第二次 push → 全部 skipped-dup，bundle 数不翻倍", async () => {
    const fx = await makeMemoryFixture();
    try {
      const srcRoot = join(fx.tmp, "proj");
      await mkdir(join(srcRoot, "sub"), { recursive: true });
      await writeFile(join(srcRoot, "a.txt"), "aaa");
      await writeFile(join(srcRoot, "sub", "b.txt"), "bbb");

      const first = await fx.pushRecursive(srcRoot, {});
      const before = await fx.countAllBundles();
      const second = await fx.pushRecursive(srcRoot, {});
      const after = await fx.countAllBundles();

      expect(first.uploaded).toBe(2);
      expect(second.skipped).toBe(2);
      expect(after).toBe(before); // 不新增
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
```

> fixture 增 `pushRecursive(srcRoot, opts)` 与 `countAllBundles()`（跨全部云端目录计数）。`pushRecursive` 内部复用被测的 `cmdPushRecursive` 逻辑或直接对 `walkLocalFiles` 结果逐个 `pushOneFile` 并统计 status。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/push-recursive-idempotency.test.ts`
Expected: FAIL

- [ ] **Step 3: 改写 `cmdPushRecursive` 逐文件走 `pushOneFile`**

`cmdPushRecursive`（`packages/cli/src/commands.ts:326-379`）的 per-file 循环体替换为：

```ts
  const contentKey = deriveContentKey(mk);
  let uploaded = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = relative(absDir, abs);
    const relDir = dirname(rel);
    const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
    info(`加密上传：${abs} → ${cloudDir}/${basename(abs)}`);
    const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, opts);
    if (r.status === "skipped-dup") skipped++;
    else if (r.status === "locked") {
      /* 跳过，不计入上传 */
    } else uploaded++;
    if (r.status === "uploaded" || r.status === "resumed") ok(`已上传：${rel} → ${r.bundleId}`);
  }
  ok(`整树完成：上传 ${uploaded}，跳过（已存在）${skipped}，共 ${files.length} 个文件 → ${rootCloud}`);
  return rootCloud;
```

`cmdPushRecursive` 的 `backend` 构造改为带并发度：`const backend = await makeBackend(rt, opts.local, resolveUploadConcurrency(rt, opts.concurrency));`；`opts` 类型增 `force?/concurrency?`。

- [ ] **Step 4: 运行测试 + 全量回归**

Run: `bun test packages/cli/test/push-recursive-idempotency.test.ts && bun test`
Expected: 全绿。

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/commands.ts packages/cli/test/push-recursive-idempotency.test.ts`

```bash
git add packages/cli/src/commands.ts packages/cli/test/push-recursive-idempotency.test.ts
git commit -m "feat(cli): push -r 复用 pushOneFile，整树去重/续传/锁一致"
```

---

## 收尾（所有任务后）

- [ ] 全量 `bun test` + `pnpm run typecheck` + `npx biome check .` + `pnpm run build` 全绿。
- [ ] 更新 `.claude/current-sprint.md`、`.claude/module-spec-registry.md`（新增 content/journal/cache 模块）、`.claude/test-registry.md`（新测试）、`.claude/sprint-plan.md`（Phase 3 · S1 完成）。
- [ ] 交由人工按 git flow 处理（本计划不 push）。

## 自审记录

- **Spec 覆盖**：G1 并发（T2）/ G2 续传接线（T3 日志 + T5 skipExisting）/ G3 上传幂等（T1 contentId + T5 去重&锁 + T4 缓存）/ 递归一致（T6）。S2 下载不在本计划（另轮）。
- **类型一致**：`pushOneFile` 的 status 联合类型在 T5/T6 一致；`makeBackend(rt, local, concurrency?)` 三参签名在 T5 定义、T6 使用一致；`ResourceMeta.contentId`/`PackOptions.contentId` T1 定义、T5 使用一致。
- **无占位符**：各步含完整测试与实现代码；fixture 明确列出需封装的能力。
- **安全**：contentId 仅入加密 encMeta；日志/缓存无密钥（T3 测试断言）；缓存只存加密态 manifest；`assertNameSegment` 防缓存键穿越（T4）。
