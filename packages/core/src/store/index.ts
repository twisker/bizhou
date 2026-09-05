/**
 * BundleStore：一个 bundle 的物料读写抽象（分片 / manifest / 预览包）。
 *
 * 关键设计：pack/unpack 流程只依赖此接口，故"加密→分片→落盘"的完整链路
 * 与存储后端解耦——本地目录（LocalBundleStore，离线可测）与百度网盘
 * （BaiduBundleStore，联网）实现同一接口，pipeline 一字不改即可切换。
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bundleDirName,
  chunkFileName,
  MANIFEST_FILENAME,
  PREVIEW_FILENAME,
} from "../bundle/index.ts";
import { BizhouError } from "../errors.ts";

export interface BundleStore {
  readonly bundleId: string;
  putChunk(seq: number, data: Buffer): Promise<void>;
  getChunk(seq: number): Promise<Buffer>;
  putManifest(json: string): Promise<void>;
  getManifest(): Promise<string>;
  putPreview(data: Buffer): Promise<void>;
  getPreview(): Promise<Buffer>;
  /** 列出已存在的分片 seq（用于断点续传判断哪些已上传）。 */
  listChunks(): Promise<number[]>;
  /** 删除整个 bundle。 */
  remove(): Promise<void>;
  /**
   * 可选：单个逻辑分片内部的传输进度（E-10）。
   *
   * 逻辑分片默认 100MB，`ProgressEvent` 只在每片完成时发一次；一个 12GB 的文件在最初
   * 的一百多兆里界面上毫无动静，用户会以为程序死了（下游自珍 GUI 真机反馈）。
   * 百度后端实际按 4MB 传输分片上传，这个钩子把那一层的进度露出来：`bytesDone` /
   * `bytesTotal` 是**当前这个逻辑分片**内已传 / 总字节。本地后端没有中间过程，不会调用。
   * 由消费方在 store 上赋值；不赋值即无开销。
   */
  sliceProgress?: (event: { seq: number; bytesDone: number; bytesTotal: number }) => void;
}

/** 本地目录实现：baseDir/<id>.bz/ 下写 000.part / manifest.json / preview.part。 */
export class LocalBundleStore implements BundleStore {
  readonly bundleId: string;
  private readonly dir: string;

  constructor(baseDir: string, bundleId: string) {
    this.bundleId = bundleId;
    this.dir = join(baseDir, bundleDirName(bundleId));
  }

  /** bundle 目录路径。 */
  get path(): string {
    return this.dir;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async putChunk(seq: number, data: Buffer): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, chunkFileName(seq)), data);
  }

  async getChunk(seq: number): Promise<Buffer> {
    return readFile(join(this.dir, chunkFileName(seq)));
  }

  async putManifest(json: string): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, MANIFEST_FILENAME), json, "utf8");
  }

  async getManifest(): Promise<string> {
    return readFile(join(this.dir, MANIFEST_FILENAME), "utf8");
  }

  async putPreview(data: Buffer): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, PREVIEW_FILENAME), data);
  }

  async getPreview(): Promise<Buffer> {
    return readFile(join(this.dir, PREVIEW_FILENAME));
  }

  async listChunks(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const seqs: number[] = [];
    for (const name of entries) {
      const m = /^(\d+)\.part$/.exec(name);
      if (m) seqs.push(Number(m[1]));
    }
    return seqs.sort((a, b) => a - b);
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** 内存实现：主要用于测试与将来的 dry-run。 */
export class MemoryBundleStore implements BundleStore {
  readonly bundleId: string;
  private chunks = new Map<number, Buffer>();
  private manifest: string | undefined;
  private preview: Buffer | undefined;

  constructor(bundleId: string) {
    this.bundleId = bundleId;
  }

  async putChunk(seq: number, data: Buffer): Promise<void> {
    this.chunks.set(seq, Buffer.from(data));
  }
  async getChunk(seq: number): Promise<Buffer> {
    const c = this.chunks.get(seq);
    if (!c) throw new BizhouError("IO", `内存 store 缺少分片 ${seq}`);
    return c;
  }
  async putManifest(json: string): Promise<void> {
    this.manifest = json;
  }
  async getManifest(): Promise<string> {
    if (this.manifest === undefined) throw new BizhouError("IO", "内存 store 缺少 manifest");
    return this.manifest;
  }
  async putPreview(data: Buffer): Promise<void> {
    this.preview = Buffer.from(data);
  }
  async getPreview(): Promise<Buffer> {
    if (!this.preview) throw new BizhouError("IO", "内存 store 缺少 preview");
    return this.preview;
  }
  async listChunks(): Promise<number[]> {
    return [...this.chunks.keys()].sort((a, b) => a - b);
  }
  async remove(): Promise<void> {
    this.chunks.clear();
    this.manifest = undefined;
    this.preview = undefined;
  }
}
