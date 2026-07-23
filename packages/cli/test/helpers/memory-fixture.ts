/**
 * push-idempotency 测试用内存夹具：不联网、不落真实云盘。
 * 提供固定 32B MK、临时 keyRoot（充当 rt.paths.dir）、一个内存 Backend
 * （由 MemoryBundleStore 包装、记录 putChunk 调用），以及驱动 `pushOneFile`
 * 所需的最小 `Runtime` 子集。
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type Backend,
  BizhouError,
  type BundleStore,
  type DirListing,
  deriveContentKey,
  generateBundleId,
  generateKey,
  hashPlaintextBuffer,
  hashPlaintextFile,
  joinCloudPath,
  journalPath,
  MemoryBundleStore,
  normalizeCloudPath,
  packResource,
  readResourceMeta,
  unpackResource,
  type UnpackResult,
  wrapDek,
  writeJournal,
} from "@bizhou/core";
import {
  type PullOneOpts,
  type PullOneResult,
  pullOneBundle,
  type PushOneOpts,
  type PushOneResult,
  pushOneFile,
  walkLocalFiles,
} from "../../src/commands.ts";
import type { Runtime } from "../../src/runtime.ts";

/** 不存在的 pid（远超常见 pid_max），用作"已死"进程的探测目标。 */
const STALE_PID = 2 ** 30;

/** 包一层 MemoryBundleStore，记录每次 putChunk 的 seq，供测试断言 skipExisting 是否生效。 */
class RecordingBundleStore implements BundleStore {
  readonly bundleId: string;
  readonly putChunkCalls: number[] = [];
  /** 记录每次 getChunk 的 seq，供下载续传测试断言 skip 的 seq 未被重新拉取。 */
  readonly getChunkCalls: number[] = [];
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
  async getChunk(seq: number): Promise<Buffer> {
    this.getChunkCalls.push(seq);
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
  /** 已 mkdir 过的目录集合，供 strictListDir 模式判断"目录是否存在"。 */
  private readonly createdDirs = new Set<string>(["/"]);
  /**
   * 是否模拟 BaiduBackend 的严格语义：对尚未创建的目录 listDir 直接抛错
   * （真实 LocalBackend 对缺失目录容错返回空列表，但 BaiduBackend 会对非零 errno 抛 BizhouError）。
   * 默认 false，保持既有测试的宽松行为；仅在需要复现"目录不存在"回归时开启。
   */
  constructor(private readonly strictListDir = false) {}

  async mkdir(cloudDir: string): Promise<void> {
    // 内存后端无需真建目录，但需记录"已创建"以配合 strictListDir。
    this.createdDirs.add(normalizeCloudPath(cloudDir));
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    const dir = normalizeCloudPath(cloudDir);
    if (this.strictListDir && !this.createdDirs.has(dir)) {
      throw new BizhouError("IO", `目录不存在（模拟百度网盘 errno）：${dir}`);
    }
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

  /** 供夹具内部直接查某 bundleId 记录的 getChunk 调用（供下载续传测试断言 skip 生效）。 */
  recordedGetChunkCalls(bundleId: string): number[] {
    return this.byBundleId.get(bundleId)?.store.getChunkCalls ?? [];
  }

  /** 跨全部云端目录统计 bundle 总数（供整树幂等测试断言"不新增"）。 */
  countAll(): number {
    return this.byBundleId.size;
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
  /**
   * 整树 push：对 `srcRoot` 下所有文件（镜像为以 `srcRoot` basename 为根的云端目录树）
   * 逐个复用 `pushOneFile`，统计各文件的落地状态。不经 `cmdPushRecursive`（其内部会调用
   * 真实 `makeBackend`），而是直接对 `walkLocalFiles` 结果逐个调用同一 `pushOneFile` 内核，
   * 与 `cmdPushRecursive` 的循环体逻辑一致。
   */
  pushRecursive(
    srcRoot: string,
    opts: PushOneOpts,
  ): Promise<{ uploaded: number; skipped: number; locked: number; total: number }>;
  countBundles(cloudDir: string): Promise<number>;
  /** 跨全部云端目录统计 bundle 总数（供整树幂等测试断言"不新增"）。 */
  countAllBundles(): Promise<number>;
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

export interface MemoryFixtureOpts {
  /** 见 MemoryBackend 构造参数说明：开启后 listDir 对未 mkdir 过的目录抛错，模拟 BaiduBackend。 */
  strictListDir?: boolean;
}

export async function makeMemoryFixture(opts: MemoryFixtureOpts = {}): Promise<MemoryFixture> {
  const tmp = await mkdtemp(join(tmpdir(), "bizhou-push-fixture-"));
  const mk = randomBytes(32); // 固定长度 32B MK（内容与随机性对测试无关，只要求形状正确）
  const contentKey = deriveContentKey(mk);
  const backend = new MemoryBackend(opts.strictListDir ?? false);

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
    async pushRecursive(srcRoot, opts) {
      const rootCloud = normalizeCloudPath(`/${basename(srcRoot)}`);
      const files = await walkLocalFiles(srcRoot);
      let uploaded = 0;
      let skipped = 0;
      let locked = 0;
      for (const abs of files) {
        const rel = relative(srcRoot, abs);
        const relDir = dirname(rel);
        const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
        const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, opts);
        if (r.status === "skipped-dup") skipped++;
        else if (r.status === "locked") locked++;
        else uploaded++;
      }
      return { uploaded, skipped, locked, total: files.length };
    },
    async countBundles(cloudDir) {
      const { bundles } = await backend.listDir(cloudDir);
      return bundles.length;
    },
    async countAllBundles() {
      return backend.countAll();
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
        chunkSize: 1,
        compression: "none",
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
        chunkSize: opts.chunkSize, // 首次上传的分片大小，续传必须沿用
        compression: "none",
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

// ---------------------------------------------------------------------------
// pull-idempotency 测试用内存夹具：复用上面的 MemoryBackend/RecordingBundleStore，
// 驱动 `pullOneBundle`（幂等/在飞锁/续传/端到端校验/原子落地）。
// ---------------------------------------------------------------------------

/** 固定云端目录，供本夹具内所有 bundle 使用（strictListDir 关闭，无需先 mkdir）。 */
const PULL_FIXTURE_DIR = "/pull-fixture";

export interface PullFixture {
  /** 临时目录：既充当落地文件的父目录，也充当 rt.paths.dir（下载日志根）。 */
  readonly tmp: string;
  readonly mk: Buffer;
  /** 用 packResource 造一个内存 bundle（含 contentId），返回其 `{fullId, dir}`。 */
  packBundle(data: Buffer, opts?: { chunkSize?: number }): Promise<{ fullId: string; dir: string }>;
  /** 驱动被测的 `pullOneBundle`。 */
  pullOne(
    fullId: string,
    dir: string,
    outPath: string,
    opts: PullOneOpts,
  ): Promise<PullOneResult>;
  /** 预置一份"存活"下载日志（startedAt=now, pid=当前进程），模拟并发/在飞下载。 */
  writeLiveDownloadLock(fullId: string, dir: string, outPath: string): Promise<void>;
  /**
   * 预置崩溃残留：`.part` 已含 `doneChunks` 对应的真实明文前缀（取自 `data`），
   * 并写一份陈旧下载日志（已死 pid + 久远 startedAt）。返回可查询 getChunk 调用记录的句柄。
   */
  seedResume(
    fullId: string,
    dir: string,
    outPath: string,
    data: Buffer,
    opts: { chunkSize: number; doneChunks: number[] },
  ): Promise<{ getChunkCalls: number[] }>;
  /**
   * 同 seedResume，但 `.part` 中 doneChunks 对应的明文被篡改（与真实内容不符），
   * 用于触发端到端 contentId 校验失败。
   */
  seedResumeCorrupt(
    fullId: string,
    dir: string,
    outPath: string,
    opts: { chunkSize: number; doneChunks: number[] },
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** 下载日志键：与 commands.ts 内 `downloadJournalKey` 同一逻辑（新 bundle 用 contentId，旧 bundle 退回 bundleId）。 */
function pullJournalKey(contentId: string | undefined, bundleId: string): string {
  return contentId && contentId.length > 0 ? contentId : bundleId;
}

export async function makePullFixture(): Promise<PullFixture> {
  const tmp = await mkdtemp(join(tmpdir(), "bizhou-pull-fixture-"));
  const mk = randomBytes(32);
  const contentKey = deriveContentKey(mk);
  const backend = new MemoryBackend(false);

  const rt: Runtime = {
    paths: { dir: tmp, vault: "", secrets: "", deviceKey: "", config: "" },
    accounts: undefined as unknown as Runtime["accounts"], // pullOneBundle 不使用 rt.accounts
    http: undefined as unknown as Runtime["http"], // pullOneBundle 不使用 rt.http
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
    async packBundle(data, opts = {}) {
      const fullId = generateBundleId();
      const dir = PULL_FIXTURE_DIR;
      const srcPath = join(tmp, `${fullId}-src.bin`);
      await writeFile(srcPath, data);
      const contentId = hashPlaintextBuffer(data, contentKey);
      const store = backend.bundleStore(fullId, dir);
      await packResource({
        filePath: srcPath,
        fileSize: data.length,
        mk,
        bundleId: fullId,
        createdAt: new Date(0).toISOString(),
        chunkSize: opts.chunkSize,
        store,
        name: basename(srcPath),
        contentId,
      });
      return { fullId, dir };
    },
    async pullOne(fullId, dir, outPath, opts) {
      return pullOneBundle(rt, backend, mk, contentKey, fullId, dir, outPath, opts);
    },
    async writeLiveDownloadLock(fullId, dir, outPath) {
      const store = backend.bundleStore(fullId, dir);
      const { manifest, meta } = await readResourceMeta(mk, store);
      const jkey = pullJournalKey(meta.contentId, fullId);
      const jpath = journalPath(tmp, "download", jkey, outPath);
      await writeJournal(jpath, {
        bundleId: fullId,
        cloudDir: dir,
        contentId: meta.contentId ?? "",
        doneChunks: [],
        totalChunks: manifest.chunks.length,
        startedAt: new Date().toISOString(), // 现在 → 存活窗口内
        pid: process.pid, // 本进程 → pidAlive 恒真
      });
    },
    async seedResume(fullId, dir, outPath, data, opts) {
      const store = backend.bundleStore(fullId, dir);
      const { manifest, meta } = await readResourceMeta(mk, store);
      const jkey = pullJournalKey(meta.contentId, fullId);
      const jpath = journalPath(tmp, "download", jkey, outPath);
      const prefixLen = manifest.chunks
        .filter((c) => opts.doneChunks.includes(c.seq))
        .reduce((a, c) => a + c.plainSize, 0);
      const partPath = `${outPath}.part`;
      await mkdir(dirname(partPath), { recursive: true });
      await writeFile(partPath, data.subarray(0, prefixLen));
      await writeJournal(jpath, {
        bundleId: fullId,
        cloudDir: dir,
        contentId: meta.contentId ?? "",
        doneChunks: [...opts.doneChunks],
        totalChunks: manifest.chunks.length,
        startedAt: new Date(0).toISOString(), // 久远过去，且 pid 不存活 → 判定为崩溃残留
        pid: STALE_PID,
      });
      return {
        get getChunkCalls(): number[] {
          return backend.recordedGetChunkCalls(fullId);
        },
      };
    },
    async seedResumeCorrupt(fullId, dir, outPath, opts) {
      const store = backend.bundleStore(fullId, dir);
      const { manifest, meta } = await readResourceMeta(mk, store);
      const jkey = pullJournalKey(meta.contentId, fullId);
      const jpath = journalPath(tmp, "download", jkey, outPath);
      const chunk0 = manifest.chunks.find((c) => opts.doneChunks.includes(c.seq));
      if (!chunk0) throw new BizhouError("INVALID_ARG", "seedResumeCorrupt: doneChunks 无对应分片");
      // 与真实明文不同的篡改字节（长度与真实首片一致，保证续传写偏移正确，但内容不符）。
      const corrupted = Buffer.alloc(chunk0.plainSize, 0xff);
      const partPath = `${outPath}.part`;
      await mkdir(dirname(partPath), { recursive: true });
      await writeFile(partPath, corrupted);
      await writeJournal(jpath, {
        bundleId: fullId,
        cloudDir: dir,
        contentId: meta.contentId ?? "",
        doneChunks: [...opts.doneChunks],
        totalChunks: manifest.chunks.length,
        startedAt: new Date(0).toISOString(),
        pid: STALE_PID,
      });
    },
    async exists(p) {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}
