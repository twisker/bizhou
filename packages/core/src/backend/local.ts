import { cp, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import { cloudBasename, normalizeCloudPath } from "../cloudpath/index.ts";
import { LocalBundleStore } from "../store/index.ts";
import type { Backend, DirListing } from "./index.ts";

/** 本地目录后端：baseDir 下用真实子目录还原云端树；bundle 为 <id>.bz 目录。 */
export class LocalBackend implements Backend {
  constructor(private readonly baseDir: string) {}

  private abs(cloudDir: string): string {
    const n = normalizeCloudPath(cloudDir);
    return n === "/" ? this.baseDir : join(this.baseDir, ...n.split("/").filter(Boolean));
  }

  async mkdir(cloudDir: string): Promise<void> {
    await mkdir(this.abs(cloudDir), { recursive: true });
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.abs(cloudDir), { withFileTypes: true });
    } catch {
      return { dirs: [], bundles: [] };
    }
    const dir = normalizeCloudPath(cloudDir);
    const dirs: string[] = [];
    const bundles: { id: string; dir: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.endsWith(BUNDLE_SUFFIX)) {
        bundles.push({ id: e.name.slice(0, -BUNDLE_SUFFIX.length), dir });
      } else {
        dirs.push(e.name);
      }
    }
    return { dirs, bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): LocalBundleStore {
    return new LocalBundleStore(this.abs(cloudDir), bundleId);
  }

  async move(srcCloudPath: string, dstDir: string): Promise<void> {
    const base = cloudBasename(normalizeCloudPath(srcCloudPath));
    await mkdir(this.abs(dstDir), { recursive: true });
    await rename(this.abs(srcCloudPath), join(this.abs(dstDir), base));
  }

  async copy(srcCloudPath: string, dstDir: string): Promise<void> {
    const base = cloudBasename(normalizeCloudPath(srcCloudPath));
    await mkdir(this.abs(dstDir), { recursive: true });
    await cp(this.abs(srcCloudPath), join(this.abs(dstDir), base), { recursive: true });
  }

  async rename(srcCloudPath: string, newName: string): Promise<void> {
    const absSrc = this.abs(srcCloudPath);
    await rename(absSrc, join(dirname(absSrc), newName));
  }
}
