/**
 * BaiduBundleStore：把 BundleStore 接口落到百度网盘。
 * 上传走 client.uploadPart（precreate→superfile2→create），下载走 list→filemetas→dlink。
 * 因实现了同一 BundleStore 接口，packResource/unpackResource 无需任何改动即可联网跑通。
 */

import {
  bundleDirName,
  chunkFileName,
  MANIFEST_FILENAME,
  PREVIEW_FILENAME,
} from "../bundle/index.ts";
import { BizhouError } from "../errors.ts";
import type { BundleStore } from "../store/index.ts";
import { APP_ROOT, type BaiduClient } from "./client.ts";

export class BaiduBundleStore implements BundleStore {
  readonly bundleId: string;
  private readonly dir: string;
  private fsidCache: Map<string, number> | undefined;

  constructor(
    private readonly client: BaiduClient,
    bundleId: string,
  ) {
    this.bundleId = bundleId;
    this.dir = `${APP_ROOT}/${bundleDirName(bundleId)}`;
  }

  private remotePath(filename: string): string {
    return `${this.dir}/${filename}`;
  }

  private async refreshFsids(): Promise<Map<string, number>> {
    const entries = await this.client.list(this.dir);
    const map = new Map<string, number>();
    for (const e of entries) if (!e.isdir) map.set(e.filename, e.fsId);
    this.fsidCache = map;
    return map;
  }

  private async fsidOf(filename: string): Promise<number> {
    let map = this.fsidCache ?? (await this.refreshFsids());
    if (!map.has(filename)) map = await this.refreshFsids(); // 缓存未命中则刷新一次
    const fsid = map.get(filename);
    if (fsid === undefined) {
      throw new BizhouError("BAIDU", `远端缺少文件：${this.remotePath(filename)}`);
    }
    return fsid;
  }

  private async downloadByName(filename: string): Promise<Buffer> {
    const fsid = await this.fsidOf(filename);
    const metas = await this.client.filemetas([fsid]);
    const dlink = metas[0]?.dlink;
    if (!dlink) throw new BizhouError("BAIDU", `无法获取 dlink：${filename}`);
    return this.client.download(dlink);
  }

  async putChunk(seq: number, data: Buffer): Promise<void> {
    await this.client.uploadPart(this.remotePath(chunkFileName(seq)), data);
    this.fsidCache = undefined; // 上传后缓存失效
  }

  async getChunk(seq: number): Promise<Buffer> {
    return this.downloadByName(chunkFileName(seq));
  }

  async putManifest(json: string): Promise<void> {
    await this.client.uploadPart(this.remotePath(MANIFEST_FILENAME), Buffer.from(json, "utf8"));
    this.fsidCache = undefined;
  }

  async getManifest(): Promise<string> {
    return (await this.downloadByName(MANIFEST_FILENAME)).toString("utf8");
  }

  async putPreview(data: Buffer): Promise<void> {
    await this.client.uploadPart(this.remotePath(PREVIEW_FILENAME), data);
    this.fsidCache = undefined;
  }

  async getPreview(): Promise<Buffer> {
    return this.downloadByName(PREVIEW_FILENAME);
  }

  async listChunks(): Promise<number[]> {
    const map = await this.refreshFsids();
    const seqs: number[] = [];
    for (const name of map.keys()) {
      const m = /^(\d+)\.part$/.exec(name);
      if (m) seqs.push(Number(m[1]));
    }
    return seqs.sort((a, b) => a - b);
  }
}
