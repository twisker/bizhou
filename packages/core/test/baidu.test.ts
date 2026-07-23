import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundleId } from "../src/bundle/index.ts";
import {
  APP_ROOT,
  BaiduClient,
  BaiduBundleStore,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type HttpClient,
  type HttpResponse,
  TRANSFER_SLICE,
} from "../src/baidu/index.ts";
import { packResource, unpackResource } from "../src/resource/index.ts";
import { createVault, unlockWithPassword } from "../src/vault/index.ts";

const CONFIG = { appKey: "APPKEY", secretKey: "SECRET" };

function jsonRes(obj: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function binRes(buf: Buffer): HttpResponse {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => ab,
  };
}

describe("OAuth", () => {
  test("授权 URL 含 response_type=code 与 client_id、编码 redirect_uri", () => {
    const url = buildAuthorizeUrl(CONFIG, "http://127.0.0.1:8899/cb", { state: "s1" });
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=APPKEY");
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A8899%2Fcb");
    expect(url).toContain("scope=basic%2Cnetdisk");
    expect(url).toContain("state=s1");
  });

  test("授权码换 token", async () => {
    const http: HttpClient = async (url) => {
      expect(url).toContain("grant_type=authorization_code");
      expect(url).toContain("code=THECODE");
      return jsonRes({ access_token: "AT", refresh_token: "RT", expires_in: 2592000, scope: "netdisk" });
    };
    const t = await exchangeCodeForToken(CONFIG, "THECODE", "http://cb", http);
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("RT");
    expect(t.expiresIn).toBe(2592000);
  });

  test("OAuth 错误响应抛错", async () => {
    const http: HttpClient = async () => jsonRes({ error: "invalid_grant", error_description: "bad" });
    await expect(exchangeCodeForToken(CONFIG, "x", "y", http)).rejects.toThrow(/invalid_grant/);
  });
});

describe("uploadPart 编排（precreate→superfile2→create）", () => {
  test("大于 4MB 的数据切成正确数量的 4MB 分片、partseq 有序、md5 一致", async () => {
    const data = randomBytes(TRANSFER_SLICE * 2 + 1000); // 3 片
    const expectedMd5 = (off: number, end: number) =>
      createHash("md5").update(data.subarray(off, end)).digest("hex");

    const seenPartseq: number[] = [];
    let createdSize = -1;
    let precreatedBlocks: string[] = [];
    const http: HttpClient = async (url, init) => {
      if (url.includes("method=precreate")) {
        const body = String(init?.body ?? "");
        const bl = JSON.parse(decodeURIComponent(body.match(/block_list=([^&]+)/)![1]!));
        precreatedBlocks = bl;
        return jsonRes({ errno: 0, uploadid: "UP1", block_list: [0, 1, 2] });
      }
      if (url.includes("superfile2")) {
        seenPartseq.push(Number(url.match(/partseq=(\d+)/)![1]));
        expect(url).toContain("uploadid=UP1");
        return jsonRes({ md5: "sliceMd5" });
      }
      if (url.includes("method=create")) {
        createdSize = Number(decodeURIComponent(String(init?.body)).match(/size=(\d+)/)![1]);
        return jsonRes({ errno: 0, fs_id: 999 });
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new BaiduClient(CONFIG, "AT", http);
    const res = await client.uploadPart(`${APP_ROOT}/x.bz/000.part`, data);

    expect(res.fsId).toBe(999);
    expect(seenPartseq).toEqual([0, 1, 2]); // 顺序上传
    expect(createdSize).toBe(data.length);
    expect(precreatedBlocks).toEqual([
      expectedMd5(0, TRANSFER_SLICE),
      expectedMd5(TRANSFER_SLICE, TRANSFER_SLICE * 2),
      expectedMd5(TRANSFER_SLICE * 2, data.length),
    ]);
  });

  test("断点续传：precreate 只返回缺失分片 → 仅上传缺失片", async () => {
    const data = randomBytes(TRANSFER_SLICE * 3); // 3 片
    const uploaded: number[] = [];
    const http: HttpClient = async (url) => {
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "UP", block_list: [2] }); // 只缺第 3 片
      if (url.includes("superfile2")) {
        uploaded.push(Number(url.match(/partseq=(\d+)/)![1]));
        return jsonRes({ md5: "m" });
      }
      if (url.includes("create")) return jsonRes({ errno: 0 });
      throw new Error("unexpected");
    };
    await new BaiduClient(CONFIG, "AT", http).uploadPart(`${APP_ROOT}/x.bz/000.part`, data);
    expect(uploaded).toEqual([2]); // 只补上缺的那片
  });

  test("秒传：precreate 返回空 block_list → 一片都不上传，直接 create", async () => {
    const data = randomBytes(TRANSFER_SLICE * 2); // 2 片
    const uploaded: number[] = [];
    let created = false;
    const http: HttpClient = async (url) => {
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "UP", block_list: [] });
      if (url.includes("superfile2")) {
        uploaded.push(Number(url.match(/partseq=(\d+)/)![1]));
        return jsonRes({ md5: "m" });
      }
      if (url.includes("create")) {
        created = true;
        return jsonRes({ errno: 0, fs_id: 1 });
      }
      throw new Error("unexpected");
    };
    await new BaiduClient(CONFIG, "AT", http).uploadPart(`${APP_ROOT}/x.bz/000.part`, data);
    expect(uploaded).toEqual([]); // 秒传：不传任何分片
    expect(created).toBe(true); // 仍然 create 合并
  });

  test("瞬时失败重试：分片上传前两次抛错、第三次成功 → 整体成功", async () => {
    const data = randomBytes(TRANSFER_SLICE); // 1 片
    let sliceAttempts = 0;
    const http: HttpClient = async (url) => {
      if (url.includes("precreate")) return jsonRes({ errno: 0, uploadid: "UP", block_list: [0] });
      if (url.includes("superfile2")) {
        sliceAttempts++;
        if (sliceAttempts < 3) throw new Error("ETIMEDOUT（模拟瞬时网络失败）");
        return jsonRes({ md5: "m" });
      }
      if (url.includes("create")) return jsonRes({ errno: 0, fs_id: 7 });
      throw new Error("unexpected");
    };
    // baseMs 调小以免测试变慢
    const client = new BaiduClient(CONFIG, "AT", http, { maxRetries: 3 });
    const res = await client.uploadPart(`${APP_ROOT}/x.bz/000.part`, data);
    expect(res.fsId).toBe(7);
    expect(sliceAttempts).toBe(3); // 前两次失败被重试，第三次成功
  });

  test("errno 非 0 → 抛 BizhouBAIDUError", async () => {
    const http: HttpClient = async (url) =>
      url.includes("precreate") ? jsonRes({ errno: 31034 }) : jsonRes({ errno: 0 });
    await expect(
      new BaiduClient(CONFIG, "AT", http).uploadPart(`${APP_ROOT}/x/000.part`, Buffer.from("hi")),
    ).rejects.toThrow(/errno=31034/);
  });
});

describe("BaiduBundleStore 端到端（模拟网盘 + 真实加密管线）", () => {
  test("packResource→BaiduStore 上传，再从 BaiduStore 下载 unpack，字节级一致", async () => {
    // 一个内存里的"假网盘"：path -> bytes
    const disk = new Map<string, Buffer>();
    let nextFsid = 1;
    const fsidByPath = new Map<string, number>();

    const http: HttpClient = async (url, init) => {
      if (url.includes("method=precreate")) {
        return jsonRes({ errno: 0, uploadid: `up-${Math.random()}`, block_list: [0] });
      }
      if (url.includes("superfile2")) {
        // 假网盘：把上传的分片按 path 累加（这里数据小，单片）
        const path = decodeURIComponent(url.match(/path=([^&]+)/)![1]!);
        const fd = init!.body as FormData;
        const blob = fd.get("file") as Blob;
        const buf = Buffer.from(await blob.arrayBuffer());
        disk.set(path, Buffer.concat([disk.get(path) ?? Buffer.alloc(0), buf]));
        return jsonRes({ md5: "m" });
      }
      if (url.includes("method=create")) {
        const path = decodeURIComponent(String(init!.body).match(/path=([^&]+)/)![1]!);
        if (!fsidByPath.has(path)) fsidByPath.set(path, nextFsid++);
        return jsonRes({ errno: 0, fs_id: fsidByPath.get(path) });
      }
      if (url.includes("method=list")) {
        const dir = decodeURIComponent(url.match(/dir=([^&]+)/)![1]!);
        const list = [...disk.keys()]
          .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
          .map((p) => ({
            fs_id: fsidByPath.get(p),
            path: p,
            server_filename: p.slice(dir.length + 1),
            size: disk.get(p)!.length,
            isdir: 0,
          }));
        return jsonRes({ errno: 0, list });
      }
      if (url.includes("method=filemetas")) {
        const fsids = JSON.parse(decodeURIComponent(url.match(/fsids=([^&]+)/)![1]!)) as number[];
        const list = fsids.map((id) => {
          const path = [...fsidByPath.entries()].find(([, v]) => v === id)![0];
          return { fs_id: id, dlink: `https://dl.example/${encodeURIComponent(path)}`, filename: path };
        });
        return jsonRes({ errno: 0, list });
      }
      if (url.startsWith("https://dl.example/")) {
        const path = decodeURIComponent(url.slice("https://dl.example/".length).split("?")[0]!);
        return binRes(disk.get(path)!);
      }
      throw new Error(`unexpected ${url}`);
    };

    const dir = await mkdtemp(join(tmpdir(), "bizhou-baidu-"));
    try {
      const { vault } = await createVault("pw", {
        createdAt: "2026-07-23T00:00:00Z",
        params: { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 },
      });
      const mk = await unlockWithPassword(vault, "pw");
      const client = new BaiduClient(CONFIG, "AT", http);
      const bundleId = generateBundleId();
      const store = new BaiduBundleStore(client, bundleId);

      const inPath = join(dir, "in.bin");
      const outPath = join(dir, "out.bin");
      const data = randomBytes(9000);
      await writeFile(inPath, data);

      await packResource({
        filePath: inPath,
        fileSize: 9000,
        mk,
        bundleId,
        createdAt: "2026-07-23T00:00:00Z",
        chunkSize: 3000, // 3 个逻辑分片
        compression: "none",
        store,
        name: "secret.bin",
      });

      const { meta } = await unpackResource({ mk, store, outPath });
      expect(meta.name).toBe("secret.bin");
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      expect(sha(await readFile(outPath))).toBe(sha(data));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mkdir + BaiduBundleStore cloudDir", () => {
  test("mkdir 走 create isdir=1，路径正确", async () => {
    let seenBody = "";
    const http: HttpClient = async (url, init) => {
      expect(url).toContain("method=create");
      seenBody = String(init?.body);
      return jsonRes({ errno: 0 });
    };
    await new BaiduClient(CONFIG, "AT", http).mkdir("/apps/bizhou/工作/2026");
    expect(decodeURIComponent(seenBody)).toContain("path=/apps/bizhou/工作/2026");
    expect(decodeURIComponent(seenBody)).toContain("isdir=1");
  });

  test("BaiduBundleStore 带 cloudDir 时 chunk 路径含子目录", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (url, init) => {
      if (url.includes("precreate")) {
        seen.push(decodeURIComponent(String(init?.body).match(/path=([^&]+)/)![1]!));
        return jsonRes({ errno: 0, uploadid: "UP", block_list: [0] });
      }
      if (url.includes("superfile2")) return jsonRes({ md5: "m" });
      if (url.includes("create")) return jsonRes({ errno: 0, fs_id: 1 });
      throw new Error("unexpected");
    };
    const store = new BaiduBundleStore(new BaiduClient(CONFIG, "AT", http), "abcd", "/工作");
    await store.putChunk(0, Buffer.from("x"));
    expect(seen[0]).toBe("/apps/bizhou/工作/abcd.bz/000.part");
  });
});
