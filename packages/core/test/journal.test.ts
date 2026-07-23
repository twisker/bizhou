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

      // 仅缺 wrappedKey（其余字段齐全）也应拒收：续传无从还原 DEK，绝不能当有效日志用。
      const noWrapped = join(dir, "no-wrapped.json");
      const { wrappedKey: _omit, ...withoutWrapped } = entry();
      await writeFile(noWrapped, JSON.stringify(withoutWrapped), "utf8");
      expect(await readJournal(noWrapped)).toBeNull();

      // 缺 chunkSize/compression（续传定钉分片映射的关键字段）也必须拒收：
      // 否则续传只能回退本次 flag，重蹈确定性 IV 的 nonce 复用。
      const noChunkSize = join(dir, "no-chunksize.json");
      const { chunkSize: _cs, ...withoutChunkSize } = entry();
      await writeFile(noChunkSize, JSON.stringify(withoutChunkSize), "utf8");
      expect(await readJournal(noChunkSize)).toBeNull();

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
