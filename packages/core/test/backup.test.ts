import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBackup, readBackups, removeBackup, updateLastBackup } from "../src/backup/index.ts";

describe("备份任务模型", () => {
  test("add→list→update→rm 往返；缺失文件读空", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk-"));
    try {
      expect(await readBackups(root)).toEqual([]);

      const j1 = await addBackup(root, { localDir: "/data/a", addedAt: "2026-07-24T00:00:00Z" });
      expect(j1.id).toMatch(/^[0-9a-f]+$/);
      const j2 = await addBackup(root, {
        localDir: "/data/b",
        cloudDir: "/备份/b",
        addedAt: "2026-07-24T01:00:00Z",
      });

      let jobs = await readBackups(root);
      expect(jobs.map((j) => j.localDir).sort()).toEqual(["/data/a", "/data/b"]);
      expect(jobs.find((j) => j.id === j2.id)?.cloudDir).toBe("/备份/b");

      await updateLastBackup(root, j1.id, "2026-07-24T02:00:00Z");
      jobs = await readBackups(root);
      expect(jobs.find((j) => j.id === j1.id)?.lastBackupAt).toBe("2026-07-24T02:00:00Z");

      expect(await removeBackup(root, j1.id)).toBe(true);
      expect(await removeBackup(root, j1.id)).toBe(false);
      jobs = await readBackups(root);
      expect(jobs.map((j) => j.id)).toEqual([j2.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("同 localDir+cloudDir 重复 add → 幂等返回原任务，不新增", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk2-"));
    try {
      const a = await addBackup(root, { localDir: "/x", addedAt: "t1" });
      const b = await addBackup(root, { localDir: "/x", addedAt: "t2" });
      expect(b.id).toBe(a.id);
      expect((await readBackups(root)).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("损坏 backups.json → readBackups 返回 []（不抛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk3-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "backups.json"), "{ not json", "utf8");
      expect(await readBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("jobs 非数组的 backups.json → readBackups 返回 []", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk4-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "backups.json"), JSON.stringify({ version: 1, jobs: {} }), "utf8");
      expect(await readBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("updateLastBackup 对不存在的 id → 不改动文件（不新增、不清空）", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk5-"));
    try {
      const j = await addBackup(root, { localDir: "/only", addedAt: "t" });
      await updateLastBackup(root, "nonexistent", "2026-07-24T00:00:00Z");
      const jobs = await readBackups(root);
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.id).toBe(j.id);
      expect(jobs[0]?.lastBackupAt).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
