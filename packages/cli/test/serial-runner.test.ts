import { describe, expect, test } from "bun:test";
import { SerialJobRunner } from "../src/daemon.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialJobRunner 串行护栏", () => {
  test("跑动中的多次 trigger 只合并成一次补跑（不并发、不丢触发）", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const runner = new SerialJobRunner(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      runs++;
      await sleep(20);
      running--;
    });

    runner.trigger(); // 第 1 次 → 开始跑
    await sleep(5); // 正在跑
    runner.trigger(); // 置脏
    runner.trigger(); // 仍脏（合并）
    runner.trigger();
    await runner.drain();

    expect(maxConcurrent).toBe(1); // 从不并发
    expect(runs).toBe(2); // 第 1 次 + 合并的补跑 1 次（3 次 trigger 合并为 1 补跑）
  });

  test("空闲时 trigger 立即跑一次", async () => {
    let runs = 0;
    const runner = new SerialJobRunner(async () => {
      runs++;
    });
    runner.trigger();
    await runner.drain();
    expect(runs).toBe(1);
  });

  test("run() 抛错也不丢合并触发、drain 不 reject、running 复位", async () => {
    let runs = 0;
    const runner = new SerialJobRunner(async () => {
      runs++;
      await sleep(20);
      throw new Error("boom"); // 每次都抛
    });

    runner.trigger(); // 第 1 次 → 跑（会抛）
    await sleep(5);
    runner.trigger(); // 运行中置脏 → 应补跑一次（即便前一次抛错）
    // drain 必须 resolve（不因 run 抛错而 reject），否则 daemon 退出会挂死
    await expect(runner.drain()).resolves.toBeUndefined();
    expect(runs).toBe(2); // 抛错后仍消费了合并的补跑

    // running 已复位：空闲 trigger 能再次立即跑
    runner.trigger();
    await runner.drain();
    expect(runs).toBe(3);
  });
});
