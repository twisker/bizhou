import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../src/backend/local.ts";

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
});
