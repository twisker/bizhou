import { APP_ROOT, type BaiduClient } from "../baidu/client.ts";
import { BaiduBundleStore } from "../baidu/store.ts";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import { normalizeCloudPath } from "../cloudpath/index.ts";
import type { Backend, DirListing } from "./index.ts";

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
    await this.client.rename(this.remote(srcCloudPath), newName);
  }
}
