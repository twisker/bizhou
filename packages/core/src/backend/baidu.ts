import { APP_ROOT, type BaiduClient, type RemoteEntry } from "../baidu/client.ts";
import { BaiduBundleStore } from "../baidu/store.ts";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import {
  assertNameSegment,
  cloudBasename,
  cloudDirname,
  normalizeCloudPath,
} from "../cloudpath/index.ts";
import { BizhouError } from "../errors.ts";
import type { Backend, DirListing, TrashEntry } from "./index.ts";

/** 百度开放平台未提供回收站管理接口（list/restore/delete/clear），只能靠 App/网页兜底。 */
const NO_TRASH_MANAGEMENT_MSG =
  "百度开放平台未提供回收站管理接口，请到百度网盘 App/网页的回收站操作";

/** 百度后端：真实目录建在 /apps/bizhou 下。 */
export class BaiduBackend implements Backend {
  constructor(private readonly client: BaiduClient) {}

  private remote(cloudDir: string): string {
    const n = normalizeCloudPath(cloudDir);
    return n === "/" ? APP_ROOT : `${APP_ROOT}${n}`;
  }

  async mkdir(cloudDir: string): Promise<void> {
    await this.client.mkdir(this.remote(cloudDir));
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    const dir = normalizeCloudPath(cloudDir);
    const entries = await this.client.list(this.remote(cloudDir));
    const dirs: string[] = [];
    const bundles: { id: string; dir: string }[] = [];
    for (const e of entries) {
      if (!e.isdir) continue;
      if (e.filename.endsWith(BUNDLE_SUFFIX)) {
        bundles.push({ id: e.filename.slice(0, -BUNDLE_SUFFIX.length), dir });
      } else {
        dirs.push(e.filename);
      }
    }
    return { dirs, bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): BaiduBundleStore {
    return new BaiduBundleStore(this.client, bundleId, cloudDir);
  }

  async move(srcCloudPath: string, dstDir: string): Promise<void> {
    await this.client.move(this.remote(srcCloudPath), this.remote(dstDir));
  }

  async copy(srcCloudPath: string, dstDir: string): Promise<void> {
    await this.client.copy(this.remote(srcCloudPath), this.remote(dstDir));
  }

  async rename(srcCloudPath: string, newName: string): Promise<void> {
    assertNameSegment(newName);
    await this.client.rename(this.remote(srcCloudPath), newName);
  }

  /** 删到百度原生回收站（filemanager delete）。deletedAt 由核心库以外注入，此后端不使用。 */
  async trashPath(cloudPath: string, _deletedAt: string): Promise<void> {
    await this.client.deletePaths([this.remote(cloudPath)]);
  }

  async listTrash(): Promise<TrashEntry[]> {
    throw new BizhouError("BAIDU", NO_TRASH_MANAGEMENT_MSG);
  }

  async restoreTrash(_entryId: string): Promise<void> {
    throw new BizhouError("BAIDU", NO_TRASH_MANAGEMENT_MSG);
  }

  async deleteTrash(_entryId: string): Promise<void> {
    throw new BizhouError("BAIDU", NO_TRASH_MANAGEMENT_MSG);
  }

  async clearTrash(): Promise<void> {
    throw new BizhouError("BAIDU", NO_TRASH_MANAGEMENT_MSG);
  }

  /**
   * 定位 cloudPath 对应的远端条目：list 父目录后按文件名匹配。
   * 找不到（含父目录本身不存在——百度 list 对不存在目录会抛错）一律按"没有此 blob"
   * 处理，返回 undefined；这与 listDir 对不存在目录的既有语义一致（见 local.ts / baidu.ts listDir）。
   * 真正的网络/鉴权失败会在下一步 filemetas/download/uploadPart 里如实抛出。
   */
  private async findBlobEntry(cloudPath: string): Promise<RemoteEntry | undefined> {
    const dir = cloudDirname(cloudPath);
    const name = cloudBasename(cloudPath);
    let entries: RemoteEntry[];
    try {
      entries = await this.client.list(this.remote(dir));
    } catch {
      return undefined;
    }
    return entries.find((e) => !e.isdir && e.filename === name);
  }

  async putBlob(cloudPath: string, data: Buffer): Promise<void> {
    normalizeCloudPath(cloudPath); // 校验（拒绝 '..'），复用既有路径规则
    await this.client.uploadPart(this.remote(cloudPath), data);
  }

  async getBlob(cloudPath: string): Promise<Buffer | null> {
    normalizeCloudPath(cloudPath);
    const entry = await this.findBlobEntry(cloudPath);
    if (!entry) return null;
    const metas = await this.client.filemetas([entry.fsId]);
    const dlink = metas[0]?.dlink;
    if (!dlink) throw new BizhouError("BAIDU", `无法获取 dlink：${cloudPath}`);
    return this.client.download(dlink);
  }

  async removeBlob(cloudPath: string): Promise<void> {
    normalizeCloudPath(cloudPath);
    const entry = await this.findBlobEntry(cloudPath);
    if (!entry) return; // 本就不存在：幂等，不发起删除请求
    await this.client.deletePaths([this.remote(cloudPath)]);
  }
}
