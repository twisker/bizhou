import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePullFixture } from "./helpers/memory-fixture.ts";

describe("pull 幂等/锁/续传（内存后端）", () => {
  test("往返：pull 出的字节与原文件一致，并原子落到最终路径（无 .part 残留）", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(250, 5);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "restored.bin");
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("restored");
      expect(await readFile(out)).toEqual(data);
      expect(await fx.exists(`${out}.part`)).toBe(false); // 已原子改名，无临时残留
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("幂等：目标已有相同内容 → skipped-dup，不重下载", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(120, 9);
      const { fullId, dir } = await fx.packBundle(data);
      const out = join(fx.tmp, "x.bin");
      await fx.pullOne(fullId, dir, out, {});
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("skipped-dup");
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("在飞锁：预置存活下载日志 → locked，不下载", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(80, 1);
      const { fullId, dir } = await fx.packBundle(data);
      const out = join(fx.tmp, "y.bin");
      await fx.writeLiveDownloadLock(fullId, dir, out); // startedAt=now, pid=process.pid
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("locked");
      expect(await fx.exists(out)).toBe(false);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("续传：崩溃残留（.part 已含 seq0 + 日志 doneChunks=[0]）→ resumed，seq0 不再 getChunk，且字节一致", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.concat([Buffer.alloc(100, 2), Buffer.alloc(100, 3), Buffer.alloc(30, 4)]);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "z.bin");
      const seen = await fx.seedResume(fullId, dir, out, data, { chunkSize: 100, doneChunks: [0] });
      const r = await fx.pullOne(fullId, dir, out, {});
      expect(r.status).toBe("resumed");
      expect(seen.getChunkCalls).not.toContain(0); // seq0 被 skip
      expect(await readFile(out)).toEqual(data); // 端到端一致
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("端到端校验：装配后的文件 contentId 不符 → 抛错、不交付（保留 .part、无最终文件）", async () => {
    const fx = await makePullFixture();
    try {
      const data = Buffer.alloc(200, 6);
      const { fullId, dir } = await fx.packBundle(data, { chunkSize: 100 });
      const out = join(fx.tmp, "bad.bin");
      // 注入损坏：seedResume 声称 doneChunks=[0] 但 .part 的 seq0 明文被篡改（内容与原不符）
      await fx.seedResumeCorrupt(fullId, dir, out, { chunkSize: 100, doneChunks: [0] });
      await expect(fx.pullOne(fullId, dir, out, {})).rejects.toThrow();
      expect(await fx.exists(out)).toBe(false); // 绝不交付损坏文件
      expect(await fx.exists(`${out}.part`)).toBe(true); // 保留供排查/重试
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
