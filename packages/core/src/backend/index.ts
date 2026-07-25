import type { BundleStore } from "../store/index.ts";

export interface DirListing {
  readonly dirs: string[]; // 子目录名（非 bundle）
  readonly bundles: { id: string; dir: string }[]; // 该目录下的 bundle
}

/** 回收站条目：本地后端持久化；百度后端管理接口不支持（见 BaiduBackend）。 */
export interface TrashEntry {
  entryId: string;
  name: string;
  originalPath: string;
  deletedAt: string;
}

export interface Backend {
  /** 建目录（mkdir -p 语义）。 */
  mkdir(cloudDir: string): Promise<void>;
  /** 列目录：分出子目录与 bundle。 */
  listDir(cloudDir: string): Promise<DirListing>;
  /** 取某目录下某 bundle 的读写句柄。 */
  bundleStore(bundleId: string, cloudDir: string): BundleStore;
  /** 移动 srcCloudPath（目录或 bundle 文件夹）到 dstDir 下，保留原末段名。 */
  move(srcCloudPath: string, dstDir: string): Promise<void>;
  /** 复制 srcCloudPath 到 dstDir 下，保留原末段名；源保留。 */
  copy(srcCloudPath: string, dstDir: string): Promise<void>;
  /** 原地改名（同目录下改末段名）。 */
  rename(srcCloudPath: string, newName: string): Promise<void>;
  /** 删到回收站（目录或 bundle 文件夹）。deletedAt 由调用方注入（核心库不读时钟）。 */
  trashPath(cloudPath: string, deletedAt: string): Promise<void>;
  /** 列回收站条目。 */
  listTrash(): Promise<TrashEntry[]>;
  /** 从回收站恢复到原路径。 */
  restoreTrash(entryId: string): Promise<void>;
  /** 从回收站永久删除单条。 */
  deleteTrash(entryId: string): Promise<void>;
  /** 清空回收站。 */
  clearTrash(): Promise<void>;

  /**
   * 通用 blob 原语：写任意字节到 cloudPath（覆盖写）。
   * 与 bundleStore 无关——不经分片/manifest，供"整份密文信封"类文件使用（如云端保险库）。
   * 注意：云端文件名不是安全边界，引擎开源、命名规则对手可读；保密性只来自内容本身已加密。
   */
  putBlob(cloudPath: string, data: Buffer): Promise<void>;
  /** 读 cloudPath 的字节；路径不存在返回 null（而非抛错），genuine IO 失败仍抛错。 */
  getBlob(cloudPath: string): Promise<Buffer | null>;
  /** 删 cloudPath；路径本就不存在时是幂等操作，不抛错。 */
  removeBlob(cloudPath: string): Promise<void>;
}

export { BaiduBackend } from "./baidu.ts";
export { LocalBackend } from "./local.ts";
export { CLOUD_VAULT_NAME, RESERVED_ROOT_NAMES, TRASH_DIR } from "./reserved.ts";
