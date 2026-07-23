import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveContentKey } from "@bizhou/core";
import { resolveUploadConcurrency } from "../src/commands.ts";
import type { Runtime } from "../src/runtime.ts";
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

  test("续传往返：崩溃后复用同一 DEK，pull 出的字节与原文件完全一致", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "d.bin");
      // 3 个逻辑分片（chunkSize=100），用随机内容确保字节级比对有意义。
      const original = randomBytes(300);
      await writeFile(f, original);
      // 真·打包一次并模拟崩溃：只留 seq 0 的密文 + 陈旧日志（含 MK 包裹的首次 DEK）。
      const seen = await fx.packThenCrashAfterChunk0(f, "/z", { chunkSize: 100 });
      const r = await fx.pushOneFile(f, "/z", { chunk: "100" });
      expect(r.status).toBe("resumed");
      expect(r.bundleId).toBe(seen.bundleId); // 复用 bundleId
      expect(seen.putChunkCalls).not.toContain(0); // 第 0 片被 skipExisting 跳过
      // 关键回归断言：续传必须复用首次 DEK，否则 seq 0（旧 DEK 密文）与新 manifest 不匹配，
      // pull 会在 sha256/GCM 校验处抛错。旧的 fresh-DEK 代码在此必失败。
      const outPath = join(fx.tmp, "d.out");
      const res = await fx.pull(seen.bundleId, "/z", outPath);
      const restored = await readFile(outPath);
      expect(restored.equals(original)).toBe(true); // 字节级往返一致
      expect(res.bytesWritten).toBe(original.length);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("nonce 复用回归：续传改用不同 --chunk 仍复现原分片，pull 字节一致", async () => {
    const fx = await makeMemoryFixture();
    try {
      const f = join(fx.tmp, "e.bin");
      // 原始首次上传使用 chunkSize=100 → 3 个逻辑分片。
      const original = randomBytes(300);
      await writeFile(f, original);
      const seen = await fx.packThenCrashAfterChunk0(f, "/n", { chunkSize: 100 });
      // 关键：续传时传入不同的 --chunk（50）。若代码采信本次 flag（chunkSize=50），
      // 则同一 (DEK, bundleId, seq) 会覆盖不同明文 → 确定性 IV 的 nonce 复用；
      // 且 seq 0 的 manifest 记录会与云端已存的 100 字节密文不符 → pull 校验失败。
      // 修复后必须固定沿用 journal 记录的 chunkSize=100，逐字节复现 seq 0。
      const r = await fx.pushOneFile(f, "/n", { chunk: "50" });
      expect(r.status).toBe("resumed");
      expect(r.bundleId).toBe(seen.bundleId);
      expect(seen.putChunkCalls).not.toContain(0); // seq 0 被 skipExisting 跳过（未重写）
      const outPath = join(fx.tmp, "e.out");
      const res = await fx.pull(seen.bundleId, "/n", outPath);
      const restored = await readFile(outPath);
      expect(restored.equals(original)).toBe(true); // 证明固定了原 chunkSize，边界一致、密文复现
      expect(res.bytesWritten).toBe(original.length);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("F1 回归：strict-listDir 后端下，首推全新云端目录仍成功（mkdir 先于去重扫描）", async () => {
    // strictListDir 模拟 BaiduBackend：listDir 对尚未 mkdir 过的目录直接抛错（真实百度网盘的 errno 行为），
    // 而非 LocalBackend 那样容错返回空列表。若 pushOneFile 仍是"先去重扫描、后 mkdir"的旧顺序，
    // 本测试会在 findDuplicateBundle → backend.listDir 处直接抛错，从而暴露回归。
    const fx = await makeMemoryFixture({ strictListDir: true });
    try {
      const f = join(fx.tmp, "fresh.bin");
      await writeFile(f, Buffer.alloc(512, 7));
      // "/全新目录" 从未被 mkdir 过：修复前会在去重扫描阶段抛 BizhouError；修复后 mkdir 先执行，成功上传。
      const r = await fx.pushOneFile(f, "/全新目录", {});
      expect(r.status).toBe("uploaded");
      expect(await fx.countBundles("/全新目录")).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("--concurrency 非数字（NaN）回退为受限有限默认值", () => {
    const rt = { uploadConcurrency: 4 } as unknown as Runtime;
    // `bz --concurrency foo` → Number("foo") = NaN；不得传播为 NaN。
    const v = resolveUploadConcurrency(rt, Number("foo"));
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(4); // 回退到 rt.uploadConcurrency，clamp 后仍为 4
    // rt.uploadConcurrency 本身缺失时也要有兜底。
    const v2 = resolveUploadConcurrency({} as unknown as Runtime, NaN);
    expect(Number.isFinite(v2)).toBe(true);
    expect(v2).toBeGreaterThanOrEqual(1);
    expect(v2).toBeLessThanOrEqual(16);
  });
});
