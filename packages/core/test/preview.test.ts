import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundleId } from "../src/bundle/index.ts";
import { BizhouError } from "../src/errors.ts";
import { openPreview, packResource } from "../src/resource/index.ts";
import { LocalBundleStore } from "../src/store/index.ts";
import { createVault, unlockWithPassword } from "../src/vault/index.ts";

const FAST = { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 } as const;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bizhou-prev-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function mk() {
  const { vault } = await createVault("pw", { createdAt: "2026-07-23T00:00:00Z", params: FAST });
  return unlockWithPassword(vault, "pw");
}

describe("预览包加密/解密", () => {
  test("附加预览 → openPreview 解出一致，manifest 记录 preview", async () => {
    const key = await mk();
    const bundleId = generateBundleId();
    const inPath = join(dir, "v.bin");
    await writeFile(inPath, randomBytes(2000));
    const store = new LocalBundleStore(dir, bundleId);
    const previewData = randomBytes(500);
    const manifest = await packResource({
      filePath: inPath,
      fileSize: 2000,
      mk: key,
      bundleId,
      createdAt: "2026-07-23T00:00:00Z",
      chunkSize: 1024,
      compression: "none",
      store,
      preview: { kind: "image", data: previewData },
    });
    expect(manifest.preview?.kind).toBe("image");

    const { kind, data } = await openPreview(key, store);
    expect(kind).toBe("image");
    expect(data.equals(previewData)).toBe(true);
  });

  test("无预览的资源 openPreview 抛错", async () => {
    const key = await mk();
    const bundleId = generateBundleId();
    const inPath = join(dir, "np.bin");
    await writeFile(inPath, randomBytes(100));
    const store = new LocalBundleStore(dir, bundleId);
    await packResource({
      filePath: inPath,
      fileSize: 100,
      mk: key,
      bundleId,
      createdAt: "2026-07-23T00:00:00Z",
      chunkSize: 1024,
      compression: "none",
      store,
    });
    await expect(openPreview(key, store)).rejects.toThrow(BizhouError);
  });
});
