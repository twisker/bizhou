import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBackup } from "@bizhou/core";
import { cmdComplete } from "../src/completion.ts";

/** 捕获 stdout（cmdComplete 用 process.stdout.write 或 console.log 逐行输出）。 */
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines;
}

describe("bz __complete 本地动态", () => {
  test("shell → bash zsh powershell", async () => {
    const rt = {} as never; // shell 分支不碰 rt
    const out = await capture(() => cmdComplete(rt, "shell"));
    expect(out).toEqual(expect.arrayContaining(["bash", "zsh", "powershell"]));
  });

  test("backup-id → backups.json 的 id", async () => {
    const keyRoot = await mkdtemp(join(tmpdir(), "bizhou-cmpl-"));
    try {
      const a = await addBackup(keyRoot, { localDir: "/x", addedAt: "t" });
      const b = await addBackup(keyRoot, { localDir: "/y", addedAt: "t" });
      const rt = { paths: { dir: keyRoot } } as never;
      const out = await capture(() => cmdComplete(rt, "backup-id"));
      expect(out).toContain(a.id);
      expect(out).toContain(b.id);
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
    }
  });

  test("account → 账号名（stub listAccounts）", async () => {
    const rt = {
      accounts: { listAccounts: async () => ({ names: ["alice", "bob"], current: "alice" }) },
    } as never;
    const out = await capture(() => cmdComplete(rt, "account"));
    expect(out).toEqual(expect.arrayContaining(["alice", "bob"]));
  });

  test("未知 ctx → 无输出、不抛", async () => {
    const rt = {} as never;
    const out = await capture(() => cmdComplete(rt, "nonsense"));
    expect(out).toEqual([]);
  });

  test("出错（backups 读失败）→ 静默无输出、不抛，且不触发解锁/网络", async () => {
    // paths.dir 指向不存在处；断言不抛且无输出
    const rt = { paths: { dir: "/nonexistent-xyz-forbidden-root/sub" } } as never;
    const out = await capture(() => cmdComplete(rt, "backup-id"));
    expect(out).toEqual([]); // readBackups 对缺失返回 []（无 id）→ 无输出
  });

  test("prefix 前缀过滤（shell）", async () => {
    const rt = {} as never;
    const out = await capture(() => cmdComplete(rt, "shell", "z"));
    expect(out).toEqual(["zsh"]);
  });

  test("底层抛错（listAccounts reject）→ 命中 catch，静默无输出、不抛", async () => {
    const rt = {
      accounts: {
        listAccounts: async () => {
          throw new Error("boom");
        },
      },
    } as never;
    const out = await capture(() => cmdComplete(rt, "account"));
    expect(out).toEqual([]); // catch 兜住 → 空输出、不抛（补全不刷屏）
  });
});
