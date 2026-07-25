import {
  APP_ROOT,
  type BaiduClient,
  ERRNO_PATH_NOT_FOUND,
  type RemoteEntry,
} from "../baidu/client.ts";
import { BaiduBundleStore } from "../baidu/store.ts";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import {
  assertNameSegment,
  cloudBasename,
  cloudDirname,
  normalizeCloudPath,
} from "../cloudpath/index.ts";
import { BaiduApiError, BizhouError } from "../errors.ts";
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
   *
   * 为什么必须精确区分"父目录确实不存在"与"list 请求失败"（这条区分是承重的，
   * 不要为了"简化"而合并回一律 catch→undefined）：
   *
   * T4 的换机流程用 getBlob(vault 路径) 判断"这台新机器上到底有没有已存在的保险库"：
   *   本地无 vault → 查云端 getBlob(vault path)
   *     ├─ 返回 vault → 用主密码解锁，取回全部资源
   *     └─ 返回 null  → 当作新用户 → bz init → 生成全新主密钥（MK）
   *
   * 如果把"网络抖动/鉴权失败/限流等导致 list 失败"也吞成 undefined（进而 getBlob
   * 返回 null），效果就是：老用户在新机器上仅仅因为一次网络抖动，就被误判为"没有
   * vault"，bz init 会为其铸造一把全新的 MK，导致云端已有的全部文件永久无法解密——
   * 这是不可逆的数据丢失，且恰恰是本次发版要防止的场景。一次误报的错误是可恢复的
   * （用户重试即可），一次误报的"不存在"会摧毁数据，两者后果不对等。
   *
   * 因此：只有 errno === ERRNO_PATH_NOT_FOUND（父目录确实不存在）才当作"没有此
   * blob"返回 undefined；其余任何失败（其它 errno、网络错误、鉴权失败、响应格式
   * 异常……）一律原样抛出，交由调用方重试或报错，绝不能悄悄退化成"判定为空"。
   */
  private async findBlobEntry(cloudPath: string): Promise<RemoteEntry | undefined> {
    const dir = cloudDirname(cloudPath);
    const name = cloudBasename(cloudPath);
    let entries: RemoteEntry[];
    try {
      entries = await this.client.list(this.remote(dir));
    } catch (err) {
      if (err instanceof BaiduApiError && err.errno === ERRNO_PATH_NOT_FOUND) {
        return undefined;
      }
      throw err;
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
