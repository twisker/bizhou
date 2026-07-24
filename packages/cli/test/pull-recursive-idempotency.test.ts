import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makePullFixture } from "./helpers/memory-fixture.ts";

describe("pull -r 幂等", () => {
  test("整树第二次 pull → 全部 skipped-dup，不重复下载", async () => {
    const fx = await makePullFixture();
    try {
      // 造两个不同目录下的 bundle
      const a = await fx.packBundle(Buffer.alloc(120, 1), { dir: "/工作" });
      const b = await fx.packBundle(Buffer.alloc(90, 2), { dir: "/工作/子" });

      const first = await fx.pullRecursive("/工作");
      const second = await fx.pullRecursive("/工作");

      expect(first.restored).toBe(2);
      expect(second.skipped).toBe(2);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
