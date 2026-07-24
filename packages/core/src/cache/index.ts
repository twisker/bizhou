/**
 * manifest 本地缓存：消除去重扫描对目标目录各 bundle manifest 的重复网络拉取。
 * 只缓存"原始 manifest（encMeta 仍加密态）"，不缓存解出的 contentId → 不把明文内容身份落盘。
 * 键 = 不可变 bundleId；rename（改 encMeta）与 rm/trash（bundle 消失）需 invalidate，mv 不需。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNameSegment } from "../cloudpath/index.ts";

const CACHE_SUBDIR = join(".cache", "manifests");

function cacheFile(keyRoot: string, bundleId: string): string {
  assertNameSegment(bundleId); // 防 bundleId 含 ../ 逃逸缓存目录
  return join(keyRoot, CACHE_SUBDIR, `${bundleId}.json`);
}

export async function getCachedManifest(keyRoot: string, bundleId: string): Promise<string | null> {
  try {
    return await readFile(cacheFile(keyRoot, bundleId), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err; // 校验失败（穿越键）等仍抛出
  }
}

export async function putCachedManifest(
  keyRoot: string,
  bundleId: string,
  rawManifest: string,
): Promise<void> {
  const path = cacheFile(keyRoot, bundleId);
  await mkdir(join(keyRoot, CACHE_SUBDIR), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, rawManifest, "utf8");
  await rename(tmp, path);
}

export async function invalidateManifest(keyRoot: string, bundleId: string): Promise<void> {
  await rm(cacheFile(keyRoot, bundleId), { force: true });
}
