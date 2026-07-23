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
}
