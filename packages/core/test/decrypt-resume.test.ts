import { describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptChunksToFile, encryptFileToChunks } from "../src/chunker/index.ts";
import { generateKey } from "../src/crypto/index.ts";
import { MemoryBundleStore } from "../src/store/index.ts";

describe("decryptChunksToFile 续传（skip）", () => {
  test("skip 已写分片 → 定位续写，结果与全量解密字节一致", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-dlr-"));
    try {
      const dek = generateKey();
      const bundleId = "abcd";
      const original = Buffer.concat([
        Buffer.alloc(100, 1),
        Buffer.alloc(100, 2),
        Buffer.alloc(50, 3),
      ]); // 250B → chunkSize 100 → seq 0/1/2
      const src = join(dir, "src.bin");
      await writeFile(src, original);
      const store = new MemoryBundleStore(bundleId);
      const chunks = await encryptFileToChunks({
        filePath: src,
        fileSize: original.length,
        dek,
        bundleId,
        chunkSize: 100,
        compression: "none",
        store,
      });

      // 模拟"seq 0 已写入临时文件"：预置 .part 只含 seq0 的明文（前 100 字节）
      const part = join(dir, "out.bin.part");
      const fh = await open(part, "w");
      await fh.write(original.subarray(0, 100), 0, 100, 0);
      await fh.close();

      const { bytesWritten } = await decryptChunksToFile({
        chunks,
        dek,
        bundleId,
        compression: "none",
        store,
        outPath: part,
        skip: [0], // 跳过 seq0（不 getChunk），续写 seq1/2
      });

      expect(bytesWritten).toBe(original.length);
      expect(await readFile(part)).toEqual(original); // 字节级一致
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skip 空 → 与旧行为一致（全量新建写出）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-dlr2-"));
    try {
      const dek = generateKey();
      const original = Buffer.alloc(300, 7);
      const src = join(dir, "s.bin");
      await writeFile(src, original);
      const store = new MemoryBundleStore("z");
      const chunks = await encryptFileToChunks({
        filePath: src,
        fileSize: 300,
        dek,
        bundleId: "z",
        chunkSize: 100,
        compression: "none",
        store,
      });
      const out = join(dir, "o.bin");
      await decryptChunksToFile({ chunks, dek, bundleId: "z", compression: "none", store, outPath: out });
      expect(await readFile(out)).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
