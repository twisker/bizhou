import { randomBytes } from "node:crypto";
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
import { RESERVED_ROOT_NAMES, TRASH_DIR } from "./reserved.ts";

/**
 * 回收站（E-6）：百度开放平台没有回收站管理接口（列出/还原/永久删除/清空都没有），
 * 走原生 delete 的话，删掉的东西只能到百度网盘 App 里翻，本产品无从管理。
 * 因此在应用沙盒内自建 `/apps/bizhou/.trash/`，语义与 LocalBackend 完全对齐。
 *
 * 代价（有意接受）：回收站里的内容仍占用网盘配额，直到用户 `trash clear`；
 * 好处：删除/还原/清空全部可编程，GUI 才可能有一个像样的回收站。
 *
 * 布局：`.trash/<entryId>/<原名>`（内容）+ `.trash/<entryId>.json`（原路径与删除时间）。
 */
const TRASH_PREFIX = `/${TRASH_DIR}`;

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
      if (RESERVED_ROOT_NAMES.has(e.filename)) continue; // 引擎自用（回收站 / 云端保险库）
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

  private trashItemDir(entryId: string): string {
    assertNameSegment(entryId); // 防 entryId 含 ../ 逃逸 .trash
    return `${TRASH_PREFIX}/${entryId}`;
  }

  private trashMetaPath(entryId: string): string {
    assertNameSegment(entryId);
    return `${TRASH_PREFIX}/${entryId}.json`;
  }

  /** 读回收站条目元数据；不存在即报错——"还原了个不存在的东西"绝不能静默成功。 */
  private async readTrashEntry(entryId: string): Promise<TrashEntry> {
    const raw = await this.getBlob(this.trashMetaPath(entryId));
    if (!raw) throw new BizhouError("BAIDU", `回收站中没有这一条：${entryId}`);
    return JSON.parse(raw.toString("utf8")) as TrashEntry;
  }

  /** `.trash` 是否已存在（尚未删过任何东西时它不存在，属正常情况，不是错误）。 */
  private async trashDirEntries(): Promise<RemoteEntry[] | null> {
    try {
      return await this.client.list(this.remote(TRASH_PREFIX));
    } catch (err) {
      if (err instanceof BaiduApiError && err.errno === ERRNO_PATH_NOT_FOUND) return null;
      throw err; // 其它失败如实抛出，不能伪装成"回收站是空的"
    }
  }

  async trashPath(cloudPath: string, deletedAt: string): Promise<void> {
    const originalPath = normalizeCloudPath(cloudPath);
    const name = cloudBasename(originalPath);
    const entryId = randomBytes(8).toString("hex");
    const itemDir = this.trashItemDir(entryId);

    await this.client.mkdir(this.remote(itemDir));
    await this.client.move(this.remote(originalPath), this.remote(itemDir));
    // 元数据后写：内容已经安全落在 .trash 里，此时写失败最坏是"条目列不出来"，
    // 而不是"东西已经从原位置消失、却哪儿都找不到"。
    const entry: TrashEntry = { entryId, name, originalPath, deletedAt };
    await this.putBlob(this.trashMetaPath(entryId), Buffer.from(JSON.stringify(entry), "utf8"));
  }

  async listTrash(): Promise<TrashEntry[]> {
    const entries = await this.trashDirEntries();
    if (entries === null) return [];
    const out: TrashEntry[] = [];
    for (const e of entries) {
      if (e.isdir || !e.filename.endsWith(".json")) continue;
      out.push(await this.readTrashEntry(e.filename.slice(0, -".json".length)));
    }
    return out;
  }

  async restoreTrash(entryId: string): Promise<void> {
    const entry = await this.readTrashEntry(entryId);
    const targetDir = cloudDirname(entry.originalPath);
    await this.client.mkdir(this.remote(targetDir)); // 原目录可能已被删掉
    await this.client.move(
      this.remote(`${this.trashItemDir(entryId)}/${entry.name}`),
      this.remote(targetDir),
    );
    await this.client.deletePaths([
      this.remote(this.trashItemDir(entryId)),
      this.remote(this.trashMetaPath(entryId)),
    ]);
  }

  async deleteTrash(entryId: string): Promise<void> {
    await this.readTrashEntry(entryId); // 不存在就报错，而不是发一次删空气的请求
    await this.client.deletePaths([
      this.remote(this.trashItemDir(entryId)),
      this.remote(this.trashMetaPath(entryId)),
    ]);
  }

  async clearTrash(): Promise<void> {
    if ((await this.trashDirEntries()) === null) return; // 本就没有回收站：幂等
    await this.client.deletePaths([this.remote(TRASH_PREFIX)]);
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
