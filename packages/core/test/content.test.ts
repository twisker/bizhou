import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey, hashPlaintextBuffer, hashPlaintextFile } from "../src/content/index.ts";

describe("contentId 内容身份", () => {
  const mkA = Buffer.alloc(32, 1);
  const mkB = Buffer.alloc(32, 2);

  test("同明文同 MK → 同 contentId；不同 MK → 不同（带密钥）", () => {
    const data = Buffer.from("hello bizhou");
    const idA1 = hashPlaintextBuffer(data, deriveContentKey(mkA));
    const idA2 = hashPlaintextBuffer(data, deriveContentKey(mkA));
    const idB = hashPlaintextBuffer(data, deriveContentKey(mkB));
    expect(idA1).toBe(idA2);
    expect(idA1).not.toBe(idB);
    expect(idA1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("流式 hashPlaintextFile 与一次性 hashPlaintextBuffer 一致（含空文件）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-content-"));
    try {
      const key = deriveContentKey(mkA);
      const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab); // 跨多次读
      const bigPath = join(dir, "big.bin");
      await writeFile(bigPath, big);
      expect(await hashPlaintextFile(bigPath, key)).toBe(hashPlaintextBuffer(big, key));

      const emptyPath = join(dir, "empty.bin");
      await writeFile(emptyPath, Buffer.alloc(0));
      expect(await hashPlaintextFile(emptyPath, key)).toBe(hashPlaintextBuffer(Buffer.alloc(0), key));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
