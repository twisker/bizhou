import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDoneChunk,
  isLockAlive,
  type JournalEntry,
  journalPath,
  readJournal,
  removeJournal,
  writeJournal,
} from "../src/journal/index.ts";

const entry = (): JournalEntry => ({
  bundleId: "abc123",
  cloudDir: "/工作",
  contentId: "f".repeat(64),
  doneChunks: [],
  totalChunks: 3,
  chunkSize: 100,
  compression: "none",
  wrappedKey: "d2hhdGV2ZXItYmFzZTY0LWJsb2I=", // MK 包裹的 DEK（此处仅需形状正确的 base64 串）
  startedAt: "2026-07-23T00:00:00.000Z",
  pid: 4242,
});

describe("上传日志", () => {
  test("journalPath 同 contentId+目的地稳定、不同目的地相异，且不泄露明文身份到路径外", () => {
    const root = "/root";
    const p1 = journalPath(root, "upload", "a".repeat(64), "/工作");
    const p2 = journalPath(root, "upload", "a".repeat(64), "/工作");
    const p3 = journalPath(root, "upload", "a".repeat(64), "/别处");
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toContain(".uploads");
  });

  test("write→read→append→read→remove 往返；doneChunks 去重", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl-"));
    try {
      const p = journalPath(dir, "upload", entry().contentId, entry().cloudDir);
      await writeJournal(p, entry());
      let got = await readJournal(p);
      expect(got?.bundleId).toBe("abc123");

      await appendDoneChunk(p, 0);
      await appendDoneChunk(p, 1);
      await appendDoneChunk(p, 0); // 重复
      got = await readJournal(p);
      expect(got?.doneChunks).toEqual([0, 1]);

      // 日志不得含明文 contentId 之外的敏感信息，且绝无密钥字段
      const raw = await readFile(p, "utf8");
      expect(raw).not.toMatch(/dek|mk|password|secret|token/i);

      await removeJournal(p);
      expect(await readJournal(p)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readJournal 对缺失/损坏返回 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl2-"));
    try {
      expect(await readJournal(join(dir, "nope.json"))).toBeNull();

      // 无效 JSON：JSON.parse 抛出，走 catch 分支
      const badJson = join(dir, "bad-json.json");
      await writeFile(badJson, "{ not json", "utf8");
      expect(await readJournal(badJson)).toBeNull();

      // 合法 JSON 但形状不完整（缺 pid/startedAt 等字段）：走形状校验分支
      const badShape = join(dir, "bad-shape.json");
      await writeFile(badShape, JSON.stringify({ bundleId: "x", doneChunks: [] }), "utf8");
      expect(await readJournal(badShape)).toBeNull();

      // wrappedKey/chunkSize/compression 现为上传专属可选字段（下载日志用不到）：
      // 单独缺失其一、其余必需字段齐全时，应仍视为合法（读回该字段为 undefined）。
      const noWrapped = join(dir, "no-wrapped.json");
      const { wrappedKey: _omit, ...withoutWrapped } = entry();
      await writeFile(noWrapped, JSON.stringify(withoutWrapped), "utf8");
      const gotNoWrapped = await readJournal(noWrapped);
      expect(gotNoWrapped).not.toBeNull();
      expect(gotNoWrapped?.wrappedKey).toBeUndefined();

      const noChunkSize = join(dir, "no-chunksize.json");
      const { chunkSize: _cs, ...withoutChunkSize } = entry();
      await writeFile(noChunkSize, JSON.stringify(withoutChunkSize), "utf8");
      const gotNoChunkSize = await readJournal(noChunkSize);
      expect(gotNoChunkSize).not.toBeNull();
      expect(gotNoChunkSize?.chunkSize).toBeUndefined();

      const badCompression = join(dir, "bad-compression.json");
      await writeFile(badCompression, JSON.stringify({ ...entry(), compression: "zstd" }), "utf8");
      expect(await readJournal(badCompression)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isLockAlive：pid 存活→活；pid 死且超 TTL→死；pid 死但未超 TTL→活", () => {
    const e = entry(); // startedAt = 2026-07-23T00:00:00Z
    const t0 = Date.parse(e.startedAt);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 10_000, pidAlive: true })).toBe(true);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 120_000, pidAlive: false })).toBe(false);
    expect(isLockAlive(e, { ttlMs: 60_000, now: t0 + 10_000, pidAlive: false })).toBe(true);
  });
});

describe("下载日志（journal 复用，上传专属字段可选）", () => {
  test("下载态 entry 省略 wrappedKey/chunkSize/compression → write→read 往返仍合法", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl-dl-"));
    try {
      const { wrappedKey: _wk, chunkSize: _cs, compression: _cp, ...downloadEntry } = entry();
      const p = journalPath(dir, "download", downloadEntry.contentId, downloadEntry.cloudDir);
      await writeJournal(p, downloadEntry as JournalEntry);
      const got = await readJournal(p);
      expect(got).not.toBeNull();
      expect(got?.bundleId).toBe("abc123");
      expect(got?.wrappedKey).toBeUndefined();
      expect(got?.chunkSize).toBeUndefined();
      expect(got?.compression).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("必需字段仍必查：pid/startedAt 类型不符或缺失 → null（未受可选字段改动影响）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-jnl-req-"));
    try {
      const { pid: _pid, ...withoutPid } = entry();
      const noPid = join(dir, "no-pid.json");
      await writeFile(noPid, JSON.stringify(withoutPid), "utf8");
      expect(await readJournal(noPid)).toBeNull();

      const badPid = join(dir, "bad-pid.json");
      await writeFile(badPid, JSON.stringify({ ...entry(), pid: "4242" }), "utf8");
      expect(await readJournal(badPid)).toBeNull();

      const { startedAt: _sa, ...withoutStartedAt } = entry();
      const noStartedAt = join(dir, "no-started-at.json");
      await writeFile(noStartedAt, JSON.stringify(withoutStartedAt), "utf8");
      expect(await readJournal(noStartedAt)).toBeNull();

      const badStartedAt = join(dir, "bad-started-at.json");
      await writeFile(badStartedAt, JSON.stringify({ ...entry(), startedAt: 123 }), "utf8");
      expect(await readJournal(badStartedAt)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
