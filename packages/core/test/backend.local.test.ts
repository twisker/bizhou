import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../src/backend/local.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "bizhou-be-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("LocalBackend", () => {
  test("mkdir 建目录、listDir 分出子目录与 bundle", async () => {
    const be = new LocalBackend(base);
    await be.mkdir("/工作/2026");
    // 在 /工作 下放一个 bundle（用 bundleStore 写 manifest 制造 .bz 目录）
    const store = be.bundleStore("deadbeef", "/工作");
    await store.putManifest("{}");

    const rootList = await be.listDir("/");
    expect(rootList.dirs).toContain("工作");

    const workList = await be.listDir("/工作");
    expect(workList.dirs).toContain("2026");
    expect(workList.bundles).toEqual([{ id: "deadbeef", dir: "/工作" }]);
  });

  test("listDir 不存在的目录 → 空", async () => {
    const be = new LocalBackend(base);
    expect(await be.listDir("/不存在")).toEqual({ dirs: [], bundles: [] });
  });

  test("mkdir 拒绝 '..' 路径穿越，无法在 baseDir 外创建目录", async () => {
    const be = new LocalBackend(base);
    await expect(be.mkdir("/../escape")).rejects.toThrow();
  });
});

describe("LocalBackend move/copy/rename（目录级）", () => {
  let base2: string;
  beforeAll(async () => {
    base2 = await mkdtemp(join(tmpdir(), "bizhou-be-mv-"));
  });
  afterAll(async () => {
    await rm(base2, { recursive: true, force: true });
  });

  test("move: /a（含 x.bz）移到 /b → /b/a 存在且含 bundle，/a 不再存在", async () => {
    const be = new LocalBackend(base2);
    await be.mkdir("/a");
    await be.bundleStore("x", "/a").putManifest("{}");

    await be.move("/a", "/b");

    expect(await exists(join(base2, "b", "a", "x.bz", "manifest.json"))).toBe(true);
    expect(await exists(join(base2, "a"))).toBe(false);
  });

  test("copy: /b/a 复制到 /c → 源 /b/a 保留、目标 /c/a 新增", async () => {
    const be = new LocalBackend(base2);
    await be.copy("/b/a", "/c");

    expect(await exists(join(base2, "b", "a", "x.bz", "manifest.json"))).toBe(true);
    expect(await exists(join(base2, "c", "a", "x.bz", "manifest.json"))).toBe(true);
  });

  test("rename: /b/a 改名 a2 → /b/a2 存在，/b/a 不再存在", async () => {
    const be = new LocalBackend(base2);
    await be.rename("/b/a", "a2");

    expect(await exists(join(base2, "b", "a2", "x.bz", "manifest.json"))).toBe(true);
    expect(await exists(join(base2, "b", "a"))).toBe(false);
  });

  test("rename: newName 含路径穿越段应拒绝，不得逃逸 baseDir", async () => {
    const be = new LocalBackend(base2);
    await be.mkdir("/some");

    await expect(be.rename("/some", "../escape")).rejects.toThrow();
  });
});

describe("LocalBackend 回收站（.trash）", () => {
  let base3: string;
  beforeAll(async () => {
    base3 = await mkdtemp(join(tmpdir(), "bizhou-be-trash-"));
  });
  afterAll(async () => {
    await rm(base3, { recursive: true, force: true });
  });

  test("trashPath 移出 /a、listTrash 记一条 originalPath=/a、restoreTrash 恢复；listDir 不含 .trash", async () => {
    const be = new LocalBackend(base3);
    await be.mkdir("/a");
    await be.bundleStore("deadbeef", "/a").putManifest("{}");

    await be.trashPath("/a", "2026-07-23T00:00:00Z");

    const rootAfterTrash = await be.listDir("/");
    expect(rootAfterTrash.dirs).not.toContain("a");
    expect(rootAfterTrash.dirs).not.toContain(".trash");

    const trashList = await be.listTrash();
    expect(trashList.length).toBe(1);
    expect(trashList[0]?.originalPath).toBe("/a");
    expect(trashList[0]?.name).toBe("a");
    expect(trashList[0]?.deletedAt).toBe("2026-07-23T00:00:00Z");
    expect(typeof trashList[0]?.entryId).toBe("string");
    expect(trashList[0]?.entryId.length).toBeGreaterThan(0);

    const entryId = trashList[0]?.entryId as string;
    await be.restoreTrash(entryId);

    const rootAfterRestore = await be.listDir("/");
    expect(rootAfterRestore.dirs).toContain("a");
    expect(await be.listTrash()).toEqual([]);
  });

  test("deleteTrash 删单条、clearTrash 清空全部", async () => {
    const be = new LocalBackend(base3);
    await be.mkdir("/b");
    await be.mkdir("/c");

    await be.trashPath("/b", "2026-07-23T01:00:00Z");
    await be.trashPath("/c", "2026-07-23T02:00:00Z");

    let list = await be.listTrash();
    expect(list.length).toBe(2);

    const bEntry = list.find((e) => e.originalPath === "/b");
    expect(bEntry).toBeDefined();
    await be.deleteTrash((bEntry as (typeof list)[number]).entryId);

    list = await be.listTrash();
    expect(list.length).toBe(1);
    expect(list[0]?.originalPath).toBe("/c");

    await be.clearTrash();
    expect(await be.listTrash()).toEqual([]);
  });

  test("listDir('/') 从不包含 .trash 目录本身", async () => {
    const be = new LocalBackend(base3);
    await be.mkdir("/d");
    await be.trashPath("/d", "2026-07-23T03:00:00Z");

    const root = await be.listDir("/");
    expect(root.dirs).not.toContain(".trash");
  });

  test("deleteTrash/restoreTrash 的 entryId 含 ../ 被拒（防 rm -rf 逃逸 .trash）", async () => {
    const be = new LocalBackend(base3);
    await expect(be.deleteTrash("../../evil")).rejects.toThrow();
    await expect(be.restoreTrash("../../evil")).rejects.toThrow();
  });
});
