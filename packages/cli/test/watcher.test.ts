import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debounce, listDirsRecursive } from "../src/watcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watcher 辅助", () => {
  test("debounce：窗口内多次 call → 只触发 1 次，且取最后参数", async () => {
    let calls = 0;
    let last = 0;
    const d = debounce((n: number) => {
      calls++;
      last = n;
    }, 30);
    d.call(1);
    d.call(2);
    d.call(3);
    expect(calls).toBe(0); // 尚未触发
    await sleep(60);
    expect(calls).toBe(1);
    expect(last).toBe(3);
  });

  test("debounce cancel：取消后不触发", async () => {
    let calls = 0;
    const d = debounce(() => {
      calls++;
    }, 20);
    d.call();
    d.cancel();
    await sleep(40);
    expect(calls).toBe(0);
  });

  test("listDirsRecursive：列出根 + 全部子目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-wr-"));
    try {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await mkdir(join(root, "c"), { recursive: true });
      const dirs = await listDirsRecursive(root);
      expect(dirs).toContain(root);
      expect(dirs).toContain(join(root, "a"));
      expect(dirs).toContain(join(root, "a", "b"));
      expect(dirs).toContain(join(root, "c"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
