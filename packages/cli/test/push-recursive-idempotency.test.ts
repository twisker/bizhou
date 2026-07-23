import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

describe("push -r 幂等", () => {
  test("整树第二次 push → 全部 skipped-dup，bundle 数不翻倍", async () => {
    const fx = await makeMemoryFixture();
    try {
      const srcRoot = join(fx.tmp, "proj");
      await mkdir(join(srcRoot, "sub"), { recursive: true });
      await writeFile(join(srcRoot, "a.txt"), "aaa");
      await writeFile(join(srcRoot, "sub", "b.txt"), "bbb");

      const first = await fx.pushRecursive(srcRoot, {});
      const before = await fx.countAllBundles();
      const second = await fx.pushRecursive(srcRoot, {});
      const after = await fx.countAllBundles();

      expect(first.uploaded).toBe(2);
      expect(second.skipped).toBe(2);
      expect(after).toBe(before); // 不新增
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
