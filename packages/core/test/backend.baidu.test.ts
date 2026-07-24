import { describe, expect, test } from "bun:test";
import { BaiduClient, type HttpClient } from "../src/baidu/index.ts";
import { BaiduBackend } from "../src/backend/baidu.ts";

const CONFIG = { appKey: "K", secretKey: "S" };
function jsonRes(o: unknown) {
  return { ok: true, status: 200, json: async () => o, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
}

describe("BaiduBackend", () => {
  test("mkdir 拼到 APP_ROOT 下", async () => {
    let body = "";
    const http: HttpClient = async (url, init) => {
      body = decodeURIComponent(String(init?.body));
      return jsonRes({ errno: 0 });
    };
    await new BaiduBackend(new BaiduClient(CONFIG, "AT", http)).mkdir("/工作/2026");
    expect(body).toContain("path=/apps/bizhou/工作/2026");
  });

  test("listDir 分出子目录与 bundle", async () => {
    const http: HttpClient = async () =>
      jsonRes({
        errno: 0,
        list: [
          { server_filename: "工作", isdir: 1, path: "/apps/bizhou/工作", fs_id: 1, size: 0 },
          { server_filename: "abcd.bz", isdir: 1, path: "/apps/bizhou/abcd.bz", fs_id: 2, size: 0 },
        ],
      });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    const r = await be.listDir("/");
    expect(r.dirs).toEqual(["工作"]);
    expect(r.bundles).toEqual([{ id: "abcd", dir: "/" }]);
  });
});

describe("BaiduBackend 回收站", () => {
  test("trashPath 走原生 filemanager opera=delete，删除 APP_ROOT 下路径", async () => {
    let url = "";
    let body = "";
    const http: HttpClient = async (u, init) => {
      url = String(u);
      body = decodeURIComponent(String(init?.body));
      return jsonRes({ errno: 0 });
    };
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await be.trashPath("/工作/a", "2026-07-23T00:00:00Z");

    expect(url).toContain("opera=delete");
    expect(body).toContain("/apps/bizhou/工作/a");
  });

  test("listTrash 拒绝并提示去百度网盘 App/网页操作", async () => {
    const http: HttpClient = async () => jsonRes({ errno: 0 });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));

    await expect(be.listTrash()).rejects.toThrow("百度网盘 App");
  });

  test("restoreTrash/deleteTrash/clearTrash 同样拒绝并提示去 App", async () => {
    const http: HttpClient = async () => jsonRes({ errno: 0 });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));

    await expect(be.restoreTrash("x")).rejects.toThrow("百度网盘 App");
    await expect(be.deleteTrash("x")).rejects.toThrow("百度网盘 App");
    await expect(be.clearTrash()).rejects.toThrow("百度网盘 App");
  });
});
