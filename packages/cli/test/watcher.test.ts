import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { debounce, listDirsRecursive, watchRecursive } from "../src/watcher.ts";

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

  test("stop() 早于异步注册落定 → 之后的变更不触发 onChange（不泄漏 watcher）", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-wr2-"));
    try {
      await mkdir(join(root, "sub"), { recursive: true });
      let fired = 0;
      // 用 platform:"linux" 走异步逐目录注册路径（listDirsRecursive().then(...)）
      const w = watchRecursive(root, () => fired++, { debounceMs: 10, platform: "linux" });
      w.stop(); // 立即停：早于 listDirsRecursive() 的 then 回调
      await sleep(60); // 让迟到的注册回调跑（应被 stopped 挡住，不开句柄）
      await writeFile(join(root, "sub", "x.txt"), "data"); // 触发变更
      await sleep(60);
      expect(fired).toBe(0); // 无泄漏 watcher → 不触发（无此守卫则会 fire）
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
