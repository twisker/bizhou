import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundleId } from "../src/bundle/index.ts";
import { AuthError, BizhouError } from "../src/errors.ts";
import { packResource, unpackResource, readResourceMeta, renameResource } from "../src/resource/index.ts";
import { LocalBundleStore, MemoryBundleStore } from "../src/store/index.ts";
import { createVault, unlockWithPassword } from "../src/vault/index.ts";

const FAST = { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 } as const;
const CREATED = "2026-07-23T00:00:00.000Z";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bizhou-res-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function mk() {
  const { vault } = await createVault("master-pass", { createdAt: CREATED, params: FAST });
  return unlockWithPassword(vault, "master-pass");
}

/** 核心断言：pack→unpack 后字节级一致（M0/M1 验收）。 */
async function roundTrip(sizeBytes: number, chunkSize: number, compression: "none" | "gzip") {
  const key = await mk();
  const bundleId = generateBundleId();
  const inPath = join(dir, `in-${bundleId}`);
  const outPath = join(dir, `out-${bundleId}`);
  const data = randomBytes(sizeBytes);
  await writeFile(inPath, data);

  const store = new LocalBundleStore(dir, bundleId);
  const manifest = await packResource({
    filePath: inPath,
    fileSize: sizeBytes,
    mk: key,
    bundleId,
    createdAt: CREATED,
    chunkSize,
    compression,
    store,
    name: "私密.bin",
  });

  const { meta, bytesWritten } = await unpackResource({ mk: key, store, outPath });
  const out = await readFile(outPath);

  expect(sha256(out)).toBe(sha256(data)); // 字节级一致
  expect(bytesWritten).toBe(sizeBytes);
  expect(meta.name).toBe("私密.bin");
  expect(meta.size).toBe(sizeBytes);
  return manifest;
}

describe("资源 pack→unpack 字节级往返（M0/M1 核心）", () => {
  test("小文件、单片、无压缩", async () => {
    const m = await roundTrip(500, 4096, "none");
    expect(m.chunks.length).toBe(1);
  });

  test("多片（size 非整除 chunkSize）", async () => {
    const m = await roundTrip(10_000, 1024, "none");
    expect(m.chunks.length).toBe(Math.ceil(10_000 / 1024));
  });

  test("size 恰为 chunkSize 整数倍 → 无多余空片", async () => {
    const m = await roundTrip(4096, 1024, "none");
    expect(m.chunks.length).toBe(4);
  });

  test("空文件 → 单个空分片，还原为空", async () => {
    const m = await roundTrip(0, 1024, "none");
    expect(m.chunks.length).toBe(1);
    expect(m.chunks[0]!.plainSize).toBe(0);
  });

  test("启用 gzip 压缩往返一致", async () => {
    await roundTrip(20_000, 4096, "gzip");
  });

  test("较大文件（3MB，多片）往返一致", async () => {
    const m = await roundTrip(3 * 1024 * 1024, 512 * 1024, "none");
    expect(m.chunks.length).toBe(6);
  });
});

describe("完整性与安全", () => {
  test("篡改某个 .part → unpack 抛错（sha256 或 GCM 校验拦截）", async () => {
    const key = await mk();
    const bundleId = generateBundleId();
    const inPath = join(dir, `t-in-${bundleId}`);
    const outPath = join(dir, `t-out-${bundleId}`);
    await writeFile(inPath, randomBytes(5000));
    const store = new LocalBundleStore(dir, bundleId);
    await packResource({ filePath: inPath, fileSize: 5000, mk: key, bundleId, createdAt: CREATED, chunkSize: 1024, compression: "none", store });

    // 篡改分片 1 的一个字节
    const partPath = join(store.path, "001.part");
    const ct = await readFile(partPath);
    ct[0] = ct[0]! ^ 0xff;
    await writeFile(partPath, ct);

    await expect(unpackResource({ mk: key, store, outPath })).rejects.toThrow(BizhouError);
  });

  test("错误 MK（错主密码）→ 解 DEK 抛 AuthError", async () => {
    const bundleId = generateBundleId();
    const inPath = join(dir, `w-in-${bundleId}`);
    const outPath = join(dir, `w-out-${bundleId}`);
    await writeFile(inPath, randomBytes(1000));
    const rightKey = await mk();
    const store = new LocalBundleStore(dir, bundleId);
    await packResource({ filePath: inPath, fileSize: 1000, mk: rightKey, bundleId, createdAt: CREATED, chunkSize: 4096, compression: "none", store });

    const wrongKey = await mk(); // 不同 vault → 不同 MK
    await expect(unpackResource({ mk: wrongKey, store, outPath })).rejects.toThrow(AuthError);
  });

  test("MemoryBundleStore 往返一致（存储无关性）", async () => {
    const key = await mk();
    const bundleId = generateBundleId();
    const inPath = join(dir, `m-in-${bundleId}`);
    const outPath = join(dir, `m-out-${bundleId}`);
    const data = randomBytes(8000);
    await writeFile(inPath, data);
    const store = new MemoryBundleStore(bundleId);
    await packResource({ filePath: inPath, fileSize: 8000, mk: key, bundleId, createdAt: CREATED, chunkSize: 3000, compression: "gzip", store });
    await unpackResource({ mk: key, store, outPath });
    expect(sha256(await readFile(outPath))).toBe(sha256(data));
  });
});

describe("renameResource（改 bundle 真名）", () => {
  test("renameResource 更改名字、wrappedKey 和分片不变、unpack 字节一致", async () => {
    const key = await mk();
    const bundleId = generateBundleId();
    const inPath = join(dir, `r-in-${bundleId}`);
    const outPath = join(dir, `r-out-${bundleId}`);
    const data = randomBytes(5000);
    await writeFile(inPath, data);

    const store = new LocalBundleStore(dir, bundleId);
    const manifest1 = await packResource({
      filePath: inPath,
      fileSize: 5000,
      mk: key,
      bundleId,
      createdAt: CREATED,
      chunkSize: 1024,
      compression: "none",
      store,
      name: "旧.bin",
    });

    // 记录原始 wrappedKey 和分片
    const originalWrappedKey = manifest1.wrappedKey;
    const originalChunks = manifest1.chunks;

    // 执行重命名
    await renameResource(key, store, "新.bin");

    // 验证名字改了
    const { meta, manifest: manifest2 } = await readResourceMeta(key, store);
    expect(meta.name).toBe("新.bin");

    // 验证 wrappedKey 和分片没变
    expect(manifest2.wrappedKey).toBe(originalWrappedKey);
    expect(manifest2.chunks).toEqual(originalChunks);

    // 验证 unpack 仍字节一致
    const { bytesWritten } = await unpackResource({ mk: key, store, outPath });
    const out = await readFile(outPath);
    expect(sha256(out)).toBe(sha256(data));
    expect(bytesWritten).toBe(5000);
  });
});
