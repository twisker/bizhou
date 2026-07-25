import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ROOT,
  BaiduClient,
  ERRNO_PATH_NOT_FOUND,
  type HttpClient,
  type HttpResponse,
} from "../src/baidu/index.ts";
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

  // chmod 权限实验在 root 下无效（root 绕过 DAC），跳过以免在以 root 运行的 CI/容器里假绿。
  const canDropPerms = process.getuid?.() !== 0;

  test.skipIf(!canDropPerms)(
    "getBlob 遇到非 ENOENT 的真实 IO 失败（如权限不足）时必须抛错，不能悄悄返回 null",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
      try {
        const be = new LocalBackend(base);
        await writeFile(join(base, "locked.bin"), "secret");
        await chmod(join(base, "locked.bin"), 0o000); // 拒绝一切读权限
        try {
          await expect(be.getBlob("/locked.bin")).rejects.toThrow();
        } finally {
          await chmod(join(base, "locked.bin"), 0o644); // 恢复权限，才能被 rm 清理
        }
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!canDropPerms)(
    "removeBlob 遇到非「本就不存在」的真实 IO 失败（如目录不可写）时必须抛错，不能悄悄吞掉",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "bizhou-blob-"));
      try {
        const be = new LocalBackend(base);
        await writeFile(join(base, "x.bin"), "hello");
        await chmod(base, 0o555); // 目录本身不可写：unlink 内部文件会失败
        try {
          await expect(be.removeBlob("/x.bin")).rejects.toThrow();
        } finally {
          await chmod(base, 0o755); // 恢复权限，才能被 rm 清理
        }
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );
});

/**
 * 一个内存里的"假网盘"：path -> bytes，供 BaiduBackend blob 测试复用。
 *
 * `listFailure` 用来模拟 `client.list()` 的两类失败，对应 findBlobEntry 里必须
 * 区分对待的两种情况：
 * - "not-found"：errno = ERRNO_PATH_NOT_FOUND（父目录确实不存在）→ 应转为 undefined
 * - "other-errno"：errno 是别的值（如鉴权失败）→ 必须原样抛出，不能吞成"不存在"
 * - "network"：连请求本身都失败（fetch 抛错）→ 同样必须原样抛出
 */
function fakeDisk(opts: { listFailure?: "not-found" | "other-errno" | "network" } = {}) {
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
      if (opts.listFailure === "not-found") {
        return jsonRes({ errno: ERRNO_PATH_NOT_FOUND, list: [] });
      }
      if (opts.listFailure === "other-errno") {
        return jsonRes({ errno: -6, list: [] }); // 例如鉴权失败，与"不存在"无关
      }
      if (opts.listFailure === "network") {
        throw new Error("network blip: fetch failed"); // 请求本身失败，压根没拿到 errno
      }
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

  test("getBlob：list 明确报告「目录不存在」（errno=ERRNO_PATH_NOT_FOUND）→ null，不抛错", async () => {
    const { http } = fakeDisk({ listFailure: "not-found" });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    expect(await be.getBlob("/vault.enc")).toBeNull();
  });

  // 回归防护：这是本次修复要堵住的数据丢失链路——换机时 getBlob(vault path) 一旦把
  // "list 请求失败"误判成"不存在"，bz init 就会为老用户铸造全新 MK，
  // 云端已有的全部文件永久无法解密。此处验证：除了「明确不存在」之外的任何
  // list 失败（不管是别的 errno 还是请求本身失败）都必须原样抛出，而不是返回 null。
  test("getBlob：list 因非「不存在」原因失败（如鉴权错误）时必须抛错，绝不能返回 null", async () => {
    const { http } = fakeDisk({ listFailure: "other-errno" });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await expect(be.getBlob("/vault.enc")).rejects.toThrow();
  });

  test("getBlob：list 请求本身失败（网络抖动）时必须抛错，绝不能返回 null", async () => {
    const { http } = fakeDisk({ listFailure: "network" });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await expect(be.getBlob("/vault.enc")).rejects.toThrow();
  });

  test("removeBlob：目录确实不存在（errno=ERRNO_PATH_NOT_FOUND）时幂等，不抛错", async () => {
    const { http } = fakeDisk({ listFailure: "not-found" });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await expect(be.removeBlob("/vault.enc")).resolves.toBeUndefined();
  });

  test("removeBlob：list 因非「不存在」原因失败时必须抛错，不能悄悄吞掉", async () => {
    const { http } = fakeDisk({ listFailure: "other-errno" });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    await expect(be.removeBlob("/vault.enc")).rejects.toThrow();
  });
});
