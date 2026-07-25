import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ROOT, BaiduClient, type HttpClient, type HttpResponse } from "../src/baidu/index.ts";
import { BaiduBackend } from "../src/backend/baidu.ts";
import { LocalBackend } from "../src/backend/local.ts";

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
function binRes(buf: Buffer): HttpResponse {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return { ok: true, status: 200, json: async () => ({}), text: async () => "", arrayBuffer: async () => ab };
}

describe("Backend blob 原语 · LocalBackend", () => {
  test("putBlob→getBlob 往返字节级一致", async () => {
    const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
    try {
      const be = new LocalBackend(base);
      const data = randomBytes(4096);
      await be.putBlob("/apps/bizhou/vault.enc", data);
      const got = await be.getBlob("/apps/bizhou/vault.enc");
      expect(got).not.toBeNull();
      expect(got?.equals(data)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("getBlob 不存在的路径 → null，不抛错", async () => {
    const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
    try {
      const be = new LocalBackend(base);
      expect(await be.getBlob("/nope.bin")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("removeBlob 后 getBlob → null", async () => {
    const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
    try {
      const be = new LocalBackend(base);
      await be.putBlob("/x.bin", Buffer.from("hello"));
      await be.removeBlob("/x.bin");
      expect(await be.getBlob("/x.bin")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("removeBlob 对不存在的路径是幂等的，不抛错", async () => {
    const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
    try {
      const be = new LocalBackend(base);
      await expect(be.removeBlob("/never-existed.bin")).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("cloudPath 含 '..' 段一律拒绝（put/get/remove）", async () => {
    const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
    try {
      const be = new LocalBackend(base);
      await expect(be.putBlob("/../escape.bin", Buffer.from("x"))).rejects.toThrow();
      await expect(be.getBlob("/../escape.bin")).rejects.toThrow();
      await expect(be.removeBlob("/../escape.bin")).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

/** 一个内存里的"假网盘"：path -> bytes，供 BaiduBackend blob 测试复用。 */
function fakeDisk() {
  const disk = new Map<string, Buffer>();
  let nextFsid = 1;
  const fsidByPath = new Map<string, number>();

  const http: HttpClient = async (url, init) => {
    if (url.includes("method=precreate")) {
      return jsonRes({ errno: 0, uploadid: `up-${Math.random()}`, block_list: [0] });
    }
    if (url.includes("superfile2")) {
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
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
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
    if (url.includes("method=filemanager")) {
      const body = decodeURIComponent(String(init?.body ?? ""));
      const filelist = JSON.parse(body.match(/filelist=([^&]+)/)![1]!) as string[];
      for (const p of filelist) {
        disk.delete(p);
        for (const [path, id] of [...fsidByPath.entries()]) if (path === p) fsidByPath.delete(path);
      }
      return jsonRes({ errno: 0 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { http, disk };
}

describe("Backend blob 原语 · BaiduBackend", () => {
  test("putBlob→getBlob 往返字节级一致（走 uploadPart/list/filemetas/download）", async () => {
    const { http } = fakeDisk();
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    const data = randomBytes(9000);
    await be.putBlob("/vault.enc", data);
    const got = await be.getBlob("/vault.enc");
    expect(got).not.toBeNull();
    expect(got?.equals(data)).toBe(true);
  });

  test("getBlob 不存在的路径 → null，不抛错", async () => {
    const { http } = fakeDisk();
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    expect(await be.getBlob("/nope.enc")).toBeNull();
  });

  test("removeBlob 后 getBlob → null", async () => {
    const { http, disk } = fakeDisk();
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await be.putBlob("/vault.enc", Buffer.from("hello"));
    expect(disk.has(`${APP_ROOT}/vault.enc`)).toBe(true);
    await be.removeBlob("/vault.enc");
    expect(await be.getBlob("/vault.enc")).toBeNull();
  });

  test("removeBlob 对不存在的路径是幂等的，不抛错", async () => {
    const { http } = fakeDisk();
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await expect(be.removeBlob("/never-existed.enc")).resolves.toBeUndefined();
  });
});
