import { describe, expect, test } from "bun:test";
import { BaiduApiError, BizhouError } from "../src/errors.ts";
import { BaiduClient, type HttpClient, type HttpResponse } from "../src/baidu/index.ts";

const CONFIG = { appKey: "K", secretKey: "S" };

function jsonRes(obj: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe("网盘配额查询（E-7）", () => {
  test("返回总量与已用（字节）", async () => {
    const http: HttpClient = async () =>
      jsonRes({ errno: 0, total: 2199023255552, used: 1099511627776, free: 1099511627776 });
    const q = await new BaiduClient(CONFIG, "AT", http).getQuota();
    expect(q.total).toBe(2199023255552);
    expect(q.used).toBe(1099511627776);
  });

  test("请求带上 access_token，打到 quota 接口", async () => {
    let seen = "";
    const http: HttpClient = async (url) => {
      seen = String(url);
      return jsonRes({ errno: 0, total: 1, used: 0 });
    };
    await new BaiduClient(CONFIG, "AT", http).getQuota();
    expect(seen).toContain("/api/quota");
    expect(seen).toContain("access_token=AT");
  });

  // 配额是要显示给用户的数字。接口失败时返回 0 会被渲染成"网盘是空的 / 满了"，
  // 比报错难查得多——所以失败必须抛分类错误。
  test("接口报 errno 时抛 BaiduApiError，绝不返回 0", async () => {
    const http: HttpClient = async () => jsonRes({ errno: -6 }); // 鉴权失败
    await expect(new BaiduClient(CONFIG, "AT", http).getQuota()).rejects.toThrow(BaiduApiError);
  });

  test("响应缺字段时抛错，绝不把 undefined 当 0", async () => {
    const http: HttpClient = async () => jsonRes({ errno: 0 });
    await expect(new BaiduClient(CONFIG, "AT", http).getQuota()).rejects.toThrow(BizhouError);
  });

  test("HTTP 层失败（网络抖动）如实抛出", async () => {
    const http: HttpClient = async () => {
      throw new Error("network blip");
    };
    await expect(new BaiduClient(CONFIG, "AT", http).getQuota()).rejects.toThrow();
  });
});
