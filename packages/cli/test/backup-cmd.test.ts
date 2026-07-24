import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackups } from "@bizhou/core";
import { cmdBackup } from "../src/daemon.ts";

async function makeRt() {
  const keyRoot = await mkdtemp(join(tmpdir(), "bizhou-bkcmd-"));
  const fileRoot = await mkdtemp(join(tmpdir(), "bizhou-fr-"));
  const rt = { paths: { dir: keyRoot }, fileRoot, now: () => 1_753_000_000_000 } as never;
  return { rt, keyRoot, fileRoot };
}

describe("bz backup add/list/rm", () => {
  test("add 已存在目录 → 写入任务；不存在目录 → 抛错", async () => {
    const { rt, keyRoot, fileRoot } = await makeRt();
    try {
      const src = join(fileRoot, "docs");
      await mkdir(src, { recursive: true });
      await cmdBackup(rt, "add", src, {});
      const jobs = await readBackups(keyRoot);
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.localDir).toBe(src);

      await expect(cmdBackup(rt, "add", join(fileRoot, "nope"), {})).rejects.toThrow();
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
      await rm(fileRoot, { recursive: true, force: true });
    }
  });

  test("add --to 记录 cloudDir；rm 删除；list 不抛", async () => {
    const { rt, keyRoot, fileRoot } = await makeRt();
    try {
      const src = join(fileRoot, "d2");
      await mkdir(src, { recursive: true });
      await cmdBackup(rt, "add", src, { to: "/备份/d2" });
      let jobs = await readBackups(keyRoot);
      expect(jobs[0]?.cloudDir).toBe("/备份/d2");

      await cmdBackup(rt, "list", undefined, {}); // 只要求不抛
      await cmdBackup(rt, "rm", jobs[0]?.id, {});
      jobs = await readBackups(keyRoot);
      expect(jobs.length).toBe(0);
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
      await rm(fileRoot, { recursive: true, force: true });
    }
  });
});
