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
});
