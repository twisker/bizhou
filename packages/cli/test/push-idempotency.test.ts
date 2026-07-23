import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveContentKey } from "@bizhou/core";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

describe("push 幂等/续传/锁（内存后端）", () => {
  test("去重：同内容第二次 push → skipped-dup，不新增 bundle", async () => {
    const fx = await makeMemoryFixture();
    try {
      const contentKey = deriveContentKey(fx.mk);
      expect(contentKey.length).toBe(32);
      const f = join(fx.tmp, "a.bin");
      await writeFile(f, Buffer.alloc(1024, 9));

      const r1 = await fx.pushOneFile(f, "/工作", {});
      expect(r1.status).toBe("uploaded");
      const r2 = await fx.pushOneFile(f, "/工作", {});
      expect(r2.status).toBe("skipped-dup");
      expect(await fx.countBundles("/工作")).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("--force：绕过去重仍上传", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "b.bin");
      await writeFile(f, Buffer.alloc(2048, 3));
      await fx.pushOneFile(f, "/x", {});
      const r = await fx.pushOneFile(f, "/x", { force: true });
      expect(r.status).toBe("uploaded");
      expect(await fx.countBundles("/x")).toBe(2);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("在飞锁：预置存活日志 → 同内容 push 得 locked，不上传", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "c.bin");
      await writeFile(f, Buffer.alloc(1000, 1));
      await fx.writeLiveLock(f, "/y"); // startedAt=now, pid=process.pid（存活）
      const r = await fx.pushOneFile(f, "/y", {});
      expect(r.status).toBe("locked");
      expect(await fx.countBundles("/y")).toBe(0);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("续传：崩溃残留日志（doneChunks=[0]）→ resumed，skipExisting 生效", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "d.bin");
      // 造 3 个逻辑分片（chunkSize 小）
      await writeFile(f, Buffer.alloc(300, 7));
      const seen = await fx.writeStaleLockWithChunk0(f, "/z", { chunkSize: 100 });
      const r = await fx.pushOneFile(f, "/z", { chunk: "100" });
      expect(r.status).toBe("resumed");
      expect(r.bundleId).toBe(seen.bundleId); // 复用 bundleId
      expect(seen.putChunkCalls).not.toContain(0); // 第 0 片被 skipExisting 跳过
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
