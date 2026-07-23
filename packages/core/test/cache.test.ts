import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCachedManifest,
  invalidateManifest,
  putCachedManifest,
} from "../src/cache/index.ts";

describe("manifest 缓存", () => {
  test("put→get 往返；invalidate 后未命中", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-cache-"));
    try {
      const raw = JSON.stringify({ bundleId: "deadbeef", encMeta: "BASE64ENC", chunks: [] });
      expect(await getCachedManifest(root, "deadbeef")).toBeNull();
      await putCachedManifest(root, "deadbeef", raw);
      expect(await getCachedManifest(root, "deadbeef")).toBe(raw);
      await invalidateManifest(root, "deadbeef");
      expect(await getCachedManifest(root, "deadbeef")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bundleId 作为单段校验：拒绝路径穿越键", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-cache2-"));
    try {
      await expect(putCachedManifest(root, "../evil", "{}")).rejects.toThrow();
      await expect(getCachedManifest(root, "../evil")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
