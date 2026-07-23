/**
 * push-idempotency 测试用内存夹具：不联网、不落真实云盘。
 * 提供固定 32B MK、临时 keyRoot（充当 rt.paths.dir）、一个内存 Backend
 * （由 MemoryBundleStore 包装、记录 putChunk 调用），以及驱动 `pushOneFile`
 * 所需的最小 `Runtime` 子集。
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Backend,
  BizhouError,
  type BundleStore,
  type DirListing,
  deriveContentKey,
  generateBundleId,
  generateKey,
  hashPlaintextFile,
  journalPath,
  MemoryBundleStore,
  normalizeCloudPath,
  packResource,
  unpackResource,
  type UnpackResult,
  wrapDek,
  writeJournal,
} from "@bizhou/core";
import { type PushOneOpts, type PushOneResult, pushOneFile } from "../../src/commands.ts";
import type { Runtime } from "../../src/runtime.ts";

/** 不存在的 pid（远超常见 pid_max），用作"已死"进程的探测目标。 */
const STALE_PID = 2 ** 30;

/** 包一层 MemoryBundleStore，记录每次 putChunk 的 seq，供测试断言 skipExisting 是否生效。 */
class RecordingBundleStore implements BundleStore {
  readonly bundleId: string;
  readonly putChunkCalls: number[] = [];
  private readonly inner: MemoryBundleStore;

  constructor(bundleId: string) {
    this.bundleId = bundleId;
    this.inner = new MemoryBundleStore(bundleId);
  }
  async putChunk(seq: number, data: Buffer): Promise<void> {
    this.putChunkCalls.push(seq);
    await this.inner.putChunk(seq, data);
  }
  /** 预置一片密文但不计入 putChunkCalls（模拟"上次已上传、本次崩溃前留下"的分片）。 */
  async seedChunk(seq: number, data: Buffer): Promise<void> {
    await this.inner.putChunk(seq, data);
  }
  getChunk(seq: number): Promise<Buffer> {
    return this.inner.getChunk(seq);
  }
  putManifest(json: string): Promise<void> {
    return this.inner.putManifest(json);
  }
  getManifest(): Promise<string> {
    return this.inner.getManifest();
  }
  putPreview(data: Buffer): Promise<void> {
    return this.inner.putPreview(data);
  }
  getPreview(): Promise<Buffer> {
    return this.inner.getPreview();
  }
  listChunks(): Promise<number[]> {
    return this.inner.listChunks();
  }
  remove(): Promise<void> {
    return this.inner.remove();
  }
}

/** 极简内存 Backend：只实现 pushOneFile/findDuplicateBundle 会用到的部分，其余方法本夹具不需要故未实现即抛错。 */
class MemoryBackend implements Backend {
  private readonly byBundleId = new Map<string, { dir: string; store: RecordingBundleStore }>();

  async mkdir(_cloudDir: string): Promise<void> {
    // 内存后端无需真建目录。
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    const dir = normalizeCloudPath(cloudDir);
    const bundles = [...this.byBundleId.entries()]
      .filter(([, v]) => v.dir === dir)
      .map(([id]) => ({ id, dir }));
    return { dirs: [], bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): BundleStore {
    const dir = normalizeCloudPath(cloudDir);
    let entry = this.byBundleId.get(bundleId);
    if (!entry) {
      entry = { dir, store: new RecordingBundleStore(bundleId) };
      this.byBundleId.set(bundleId, entry);
    }
    return entry.store;
  }

  /** 供夹具内部直接查某 bundleId 记录的 putChunk 调用（不经 Backend 接口）。 */
  recordedCalls(bundleId: string): number[] {
    return this.byBundleId.get(bundleId)?.store.putChunkCalls ?? [];
  }

  /** 预置一个 bundle：仅含给定的已上传分片密文（不计入 putChunkCalls），无 manifest。模拟崩溃残留。 */
  async seedBundle(bundleId: string, cloudDir: string, chunks: Map<number, Buffer>): Promise<void> {
    const dir = normalizeCloudPath(cloudDir);
    const store = new RecordingBundleStore(bundleId);
    for (const [seq, data] of chunks) await store.seedChunk(seq, data);
    this.byBundleId.set(bundleId, { dir, store });
  }

  async move(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 move（本夹具不需要）");
  }
  async copy(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 copy（本夹具不需要）");
  }
  async rename(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 rename（本夹具不需要）");
  }
  async trashPath(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 trashPath（本夹具不需要）");
  }
  async listTrash(): Promise<never[]> {
    return [];
  }
  async restoreTrash(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 restoreTrash（本夹具不需要）");
  }
  async deleteTrash(): Promise<void> {
    throw new BizhouError("IO", "内存后端未实现 deleteTrash（本夹具不需要）");
  }
  async clearTrash(): Promise<void> {
    /* no-op */
  }
}

export interface MemoryFixture {
  /** 临时目录：既放待上传的源文件，也充当 rt.paths.dir（密钥根/日志根）。 */
  readonly tmp: string;
  readonly mk: Buffer;
  pushOneFile(absFile: string, cloudDir: string, opts: PushOneOpts): Promise<PushOneResult>;
  countBundles(cloudDir: string): Promise<number>;
  writeLiveLock(absFile: string, cloudDir: string): Promise<{ bundleId: string }>;
  /**
   * 真·打包一次到内存 store（产出真实 DEK 加密的分片密文），随后模拟崩溃：
   * 只保留 seq 0 的密文、丢弃 manifest 与其余分片，并写一份陈旧续传日志
   * （含 MK 包裹的同一 DEK）。返回续传所需信息 + 延迟读取的 putChunkCalls。
   */
  packThenCrashAfterChunk0(
    absFile: string,
    cloudDir: string,
    opts: { chunkSize: number },
  ): Promise<{ bundleId: string; putChunkCalls: number[] }>;
  /** 从内存 store 拉回并解密 bundle 到 outPath（校验 sha256/GCM），供往返一致性断言。 */
  pull(bundleId: string, cloudDir: string, outPath: string): Promise<UnpackResult>;
}

export async function makeMemoryFixture(): Promise<MemoryFixture> {
  const tmp = await mkdtemp(join(tmpdir(), "bizhou-push-fixture-"));
  const mk = randomBytes(32); // 固定长度 32B MK（内容与随机性对测试无关，只要求形状正确）
  const contentKey = deriveContentKey(mk);
  const backend = new MemoryBackend();

  const rt: Runtime = {
    paths: { dir: tmp, vault: "", secrets: "", deviceKey: "", config: "" },
    accounts: undefined as unknown as Runtime["accounts"], // pushOneFile 不使用 rt.accounts
    http: undefined as unknown as Runtime["http"], // pushOneFile 不使用 rt.http
    fileRoot: tmp,
    uploadConcurrency: 4,
    now: () => Date.now(),
    oauthConfig: () => {
      throw new BizhouError("IO", "内存夹具不支持 oauthConfig");
    },
    loadVault: () => {
      throw new BizhouError("IO", "内存夹具不支持 loadVault");
    },
    vaultExists: () => false,
    saveVault: () => {
      throw new BizhouError("IO", "内存夹具不支持 saveVault");
    },
    resolveMk: async () => mk,
  };

  return {
    tmp,
    mk,
    async pushOneFile(absFile, cloudDir, opts) {
      return pushOneFile(rt, backend, mk, contentKey, absFile, normalizeCloudPath(cloudDir), opts);
    },
    async countBundles(cloudDir) {
      const { bundles } = await backend.listDir(cloudDir);
      return bundles.length;
    },
    async writeLiveLock(absFile, cloudDir) {
      const contentId = await hashPlaintextFile(absFile, contentKey);
      const dir = normalizeCloudPath(cloudDir);
      const bundleId = generateBundleId();
      const jpath = journalPath(tmp, "upload", contentId, dir);
      await writeJournal(jpath, {
        bundleId,
        cloudDir: dir,
        contentId,
        doneChunks: [],
        totalChunks: 1,
        wrappedKey: wrapDek(mk, generateKey()), // 形状正确即可（存活锁不会被续传）
        startedAt: new Date().toISOString(), // 现在 → 存活窗口内
        pid: process.pid, // 本进程 → pidAlive 恒真
      });
      return { bundleId };
    },
    async packThenCrashAfterChunk0(absFile, cloudDir, opts) {
      const contentId = await hashPlaintextFile(absFile, contentKey);
      const dir = normalizeCloudPath(cloudDir);
      const bundleId = generateBundleId();
      const dek = generateKey(); // 首次上传使用的 DEK
      const { size } = await stat(absFile);
      const totalChunks = Math.max(1, Math.ceil(size / opts.chunkSize));

      // 1. 真·打包一次：产出该 DEK 加密的全部分片密文 + manifest（写到临时 store）。
      const fullStore = new MemoryBundleStore(bundleId);
      await packResource({
        filePath: absFile,
        fileSize: size,
        mk,
        dek,
        bundleId,
        createdAt: new Date(0).toISOString(),
        chunkSize: opts.chunkSize,
        store: fullStore,
        name: basename(absFile),
        contentId,
      });

      // 2. 模拟崩溃：只把 seq 0 的真实密文留给 backend，丢弃 manifest 与其余分片。
      const chunk0 = await fullStore.getChunk(0);
      await backend.seedBundle(bundleId, dir, new Map([[0, chunk0]]));

      // 3. 写陈旧续传日志：含 MK 包裹的同一 DEK、doneChunks=[0]、已死 pid。
      const jpath = journalPath(tmp, "upload", contentId, dir);
      await writeJournal(jpath, {
        bundleId,
        cloudDir: dir,
        contentId,
        doneChunks: [0],
        totalChunks,
        wrappedKey: wrapDek(mk, dek),
        startedAt: new Date(0).toISOString(), // 久远过去，且 pid 不存活 → 判定为崩溃残留
        pid: STALE_PID,
      });
      return {
        bundleId,
        get putChunkCalls(): number[] {
          return backend.recordedCalls(bundleId);
        },
      };
    },
    async pull(bundleId, cloudDir, outPath) {
      const store = backend.bundleStore(bundleId, normalizeCloudPath(cloudDir));
      return unpackResource({ mk, store, outPath });
    },
  };
}

/** 测试文件结束前清理临时目录（调用方负责，此处仅导出以备直接使用）。 */
export async function cleanupMemoryFixture(fx: MemoryFixture): Promise<void> {
  await rm(fx.tmp, { recursive: true, force: true });
}
