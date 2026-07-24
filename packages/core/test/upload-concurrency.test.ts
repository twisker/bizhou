import { describe, expect, test } from "bun:test";
import { BaiduClient, type HttpClient, type HttpResponse } from "../src/baidu/client.ts";

function jsonRes(obj: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** 造一个 4 个 4MB 分片的 buffer（16MB+1，凑 5 片以便观察并发）。 */
const DATA = Buffer.alloc(4 * 1024 * 1024 * 4 + 1, 7);

describe("uploadPart 并发", () => {
  test("片内 4MB 分片以 ≤concurrency 并发上传，且全部上传", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const uploaded = new Set<string>();
    const http: HttpClient = async (url, init) => {
      // 不带 block_list：precreate 回退到"全部分片皆需上传"（与 baidu.test.ts 既有断点续传/秒传语义一致）。
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "U" });
      if (url.includes("superfile2")) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
        const seq = new URL(url).searchParams.get("partseq");
        uploaded.add(seq ?? "");
        return jsonRes({ md5: `m${seq}` });
      }
      if (url.includes("create")) return jsonRes({ errno: 0, fs_id: 123 });
      return jsonRes({ errno: 0 });
    };
    const client = new BaiduClient({ appKey: "k", secretKey: "s" }, "tok", http, {
      uploadConcurrency: 3,
    });
    await client.uploadPart("/apps/bizhou/x/000.part", DATA);
    expect(maxInflight).toBeGreaterThan(1); // 确有并发
    expect(maxInflight).toBeLessThanOrEqual(3); // 不超过池上限
    expect(uploaded.size).toBe(5); // 5 片全传
  });

  test("fail-fast：某分片重试耗尽 → 抛错且不调 create", async () => {
    let createCalled = false;
    const http: HttpClient = async (url) => {
      // 不带 block_list：precreate 回退到"全部分片皆需上传"（与 baidu.test.ts 既有断点续传/秒传语义一致）。
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "U" });
      if (url.includes("superfile2")) {
        const seq = new URL(url).searchParams.get("partseq");
        if (seq === "2") throw new Error("boom slice 2");
        return jsonRes({ md5: `m${seq}` });
      }
      if (url.includes("create")) {
        createCalled = true;
        return jsonRes({ errno: 0, fs_id: 1 });
      }
      return jsonRes({ errno: 0 });
    };
    const client = new BaiduClient({ appKey: "k", secretKey: "s" }, "tok", http, {
      uploadConcurrency: 3,
      maxRetries: 2,
    });
    await expect(client.uploadPart("/apps/bizhou/x/000.part", DATA)).rejects.toThrow(
      /boom slice 2/,
    );
    expect(createCalled).toBe(false);
  });
});
