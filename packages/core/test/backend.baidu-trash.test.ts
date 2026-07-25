/**
 * BaiduBackend 回收站（E-6）：百度开放平台不提供回收站管理接口，因此在
 * /apps/bizhou/.trash/ 自建，语义对齐 LocalBackend（列出 / 还原 / 单条删 / 清空）。
 */

import { describe, expect, test } from "bun:test";
import { APP_ROOT, BaiduClient } from "../src/baidu/index.ts";
import { BaiduBackend } from "../src/backend/baidu.ts";
import { makeFakeNetdisk } from "./helpers/fake-netdisk.ts";

const CONFIG = { appKey: "K", secretKey: "S" };
const DELETED_AT = "2026-07-25T10:00:00.000Z";

function setup() {
  const disk = makeFakeNetdisk();
  const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", disk.http));
  return { disk, be };
}

describe("BaiduBackend 回收站（.trash 目录方案）", () => {
  test("trashPath 把目标移进 .trash，原位置不再存在", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/工作/报告.bz`);

    await be.trashPath("/工作/报告.bz", DELETED_AT);

    expect(disk.has(`${APP_ROOT}/工作/报告.bz`)).toBe(false);
    const inTrash = [...disk.dirs].some(
      (d) => d.startsWith(`${APP_ROOT}/.trash/`) && d.endsWith("/报告.bz"),
    );
    expect(inTrash).toBe(true);
  });

  // 回归防护：v1.0.x 走的是原生 filemanager delete（进百度自己的回收站，本产品管不了）。
  test("trashPath 不再发原生 delete 请求", async () => {
    const disk = makeFakeNetdisk();
    const seen: string[] = [];
    const be = new BaiduBackend(
      new BaiduClient(CONFIG, "AT", async (u, init) => {
        seen.push(String(u));
        return disk.http(u, init);
      }),
    );
    disk.mkdirp(`${APP_ROOT}/a.bz`);

    await be.trashPath("/a.bz", DELETED_AT);

    expect(seen.some((u) => u.includes("opera=delete"))).toBe(false);
    expect(seen.some((u) => u.includes("opera=move"))).toBe(true);
  });

  test("listTrash 列出条目，含原路径与删除时间", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/工作/报告.bz`);
    await be.trashPath("/工作/报告.bz", DELETED_AT);

    const entries = await be.listTrash();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("报告.bz");
    expect(entries[0]!.originalPath).toBe("/工作/报告.bz");
    expect(entries[0]!.deletedAt).toBe(DELETED_AT);
    expect(entries[0]!.entryId.length).toBeGreaterThan(0);
  });

  test("restoreTrash 还原到原路径，条目从回收站消失", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/工作/报告.bz`);
    await be.trashPath("/工作/报告.bz", DELETED_AT);
    const [entry] = await be.listTrash();

    await be.restoreTrash(entry!.entryId);

    expect(disk.has(`${APP_ROOT}/工作/报告.bz`)).toBe(true);
    expect(await be.listTrash()).toEqual([]);
  });

  test("原目录已被删掉时，restoreTrash 也能把父目录建回来", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/工作/报告.bz`);
    await be.trashPath("/工作/报告.bz", DELETED_AT);
    disk.dirs.delete(`${APP_ROOT}/工作`);
    const [entry] = await be.listTrash();

    await be.restoreTrash(entry!.entryId);

    expect(disk.has(`${APP_ROOT}/工作/报告.bz`)).toBe(true);
  });

  test("deleteTrash 只永久删掉指定的那一条", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/a.bz`);
    disk.mkdirp(`${APP_ROOT}/b.bz`);
    await be.trashPath("/a.bz", DELETED_AT);
    await be.trashPath("/b.bz", DELETED_AT);
    const entries = await be.listTrash();
    const victim = entries.find((e) => e.name === "a.bz")!;

    await be.deleteTrash(victim.entryId);

    const left = await be.listTrash();
    expect(left.map((e) => e.name)).toEqual(["b.bz"]);
  });

  test("clearTrash 清空回收站", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/a.bz`);
    await be.trashPath("/a.bz", DELETED_AT);

    await be.clearTrash();

    expect(await be.listTrash()).toEqual([]);
  });

  test("回收站为空（.trash 尚不存在）时 listTrash 返回空数组，不抛错", async () => {
    const { be } = setup();
    expect(await be.listTrash()).toEqual([]);
  });

  test("listDir 不把 .trash 当作用户目录列出来", async () => {
    const { disk, be } = setup();
    disk.mkdirp(`${APP_ROOT}/工作`);
    disk.mkdirp(`${APP_ROOT}/a.bz`);
    await be.trashPath("/a.bz", DELETED_AT);

    const listing = await be.listDir("/");
    expect(listing.dirs).toEqual(["工作"]);
    expect(listing.bundles).toEqual([]);
  });

  test("entryId 含路径分隔符时拒绝（防止穿越出 .trash）", async () => {
    const { be } = setup();
    await expect(be.restoreTrash("../../etc")).rejects.toThrow();
    await expect(be.deleteTrash("../../etc")).rejects.toThrow();
  });

  test("entryId 不存在时报错，不静默成功", async () => {
    const { be } = setup();
    await expect(be.restoreTrash("deadbeefdeadbeef")).rejects.toThrow();
  });
});
