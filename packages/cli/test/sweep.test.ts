import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveContentKey } from "@bizhou/core";
import { sweepJob } from "../src/daemon.ts";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

describe("sweepJob 引擎", () => {
  test("首扫全部 uploaded；再扫全部 skipped；改一个文件→仅它 re-upload；坏文件计 failed 且不中断", async () => {
    const fx = await makeMemoryFixture();
    try {
      const contentKey = deriveContentKey(fx.mk);
      const src = join(fx.tmp, "proj");
      await mkdir(join(src, "sub"), { recursive: true });
      await writeFile(join(src, "a.txt"), "aaa");
      await writeFile(join(src, "sub", "b.txt"), "bbb");
      const job = { id: "j1", localDir: src, addedAt: "t" };

      const r1 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r1.uploaded).toBe(2);
      expect(r1.failed).toBe(0);

      const r2 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r2.skipped).toBe(2);
      expect(r2.uploaded).toBe(0);

      await writeFile(join(src, "a.txt"), "aaa-CHANGED");
      const r3 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r3.uploaded).toBe(1);
      expect(r3.skipped).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("单文件 pushOneFile 抛错 → 计入 failed，其余继续，sweep 不整体失败", async () => {
    const fx = await makeMemoryFixture({ failOnFile: "bad.txt" }); // 夹具让含该名的文件上传抛错
    try {
      const contentKey = deriveContentKey(fx.mk);
      const src = join(fx.tmp, "p2");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "good.txt"), "g");
      await writeFile(join(src, "bad.txt"), "b");
      const job = { id: "j2", localDir: src, addedAt: "t" };
      const r = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r.failed).toBe(1);
      expect(r.uploaded).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
