import type { BundleStore } from "../store/index.ts";

export interface DirListing {
  readonly dirs: string[]; // 子目录名（非 bundle）
  readonly bundles: { id: string; dir: string }[]; // 该目录下的 bundle
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
}

export { BaiduBackend } from "./baidu.ts";
export { LocalBackend } from "./local.ts";
