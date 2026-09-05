/**
 * E-11：未完成 manifest。
 * 上传一开始就有一份带真名的 manifest（pending），传完后被最终版覆盖；pending 期间取回必须拒绝。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundleId, parseManifest } from "../src/bundle/index.ts";
import { packResource, readResourceMeta, unpackResource } from "../src/resource/index.ts";
import { MemoryBundleStore } from "../src/store/index.ts";
import { createVault, unlockWithPassword } from "../src/vault/index.ts";

const LIGHT = { algo: "scrypt" as const, N: 1 << 12, r: 8, p: 1, keylen: 32 };

describe("未完成 manifest（E-11）", () => {
  test("上传开始即写 pending manifest（真名可读、分片为空），传完被无 pending 的最终版覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bz-pending-"));
    const file = join(dir, "旅行视频.mp4");
    await writeFile(file, Buffer.alloc(3 * 1024 + 7, 1));
    const { vault } = await createVault("pw pw pw pw 敝帚", { createdAt: "2026-09-06T00:00:00Z", params: LIGHT });
    const mk = await unlockWithPassword(vault, "pw pw pw pw 敝帚");

    const store = new MemoryBundleStore(generateBundleId());
    const writes: { manifest: string; chunksAtThatTime: number }[] = [];
    const origPut = store.putManifest.bind(store);
    store.putManifest = async (json: string) => {
      writes.push({ manifest: json, chunksAtThatTime: (await store.listChunks()).length });
      await origPut(json);
    };

    await packResource({
      filePath: file, fileSize: 3 * 1024 + 7, mk, bundleId: store.bundleId,
      createdAt: "2026-09-06T00:00:00Z", chunkSize: 1024, store, name: "旅行视频.mp4",
    });

    expect(writes.length).toBe(2);
    const first = parseManifest(writes[0]!.manifest);
    expect(first.pending).toBe(true);
    expect(first.chunks).toEqual([]);
    expect(writes[0]!.chunksAtThatTime).toBe(0); // 第一片写之前就有了
    const last = parseManifest(writes[1]!.manifest);
    expect(last.pending).toBeUndefined();
    expect(last.chunks.length).toBe(4);
    // pending 期间也能读出真名
    const { meta } = await readResourceMeta(mk, { ...store, getManifest: async () => writes[0]!.manifest } as never);
    expect(meta.name).toBe("旅行视频.mp4");
    await rm(dir, { recursive: true, force: true });
  });

  test("pending 期间取回明确拒绝，不产出半个文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bz-pending-"));
    const file = join(dir, "a.bin");
    await writeFile(file, Buffer.alloc(2048, 2));
    const { vault } = await createVault("pw pw pw pw 敝帚", { createdAt: "2026-09-06T00:00:00Z", params: LIGHT });
    const mk = await unlockWithPassword(vault, "pw pw pw pw 敝帚");
    const store = new MemoryBundleStore(generateBundleId());
    let pendingJson = "";
    const origPut = store.putManifest.bind(store);
    store.putManifest = async (json: string) => {
      if (!pendingJson) pendingJson = json;
      await origPut(json);
    };
    await packResource({ filePath: file, fileSize: 2048, mk, bundleId: store.bundleId, createdAt: "2026-09-06T00:00:00Z", chunkSize: 1024, store });
    const stuck = { ...store, bundleId: store.bundleId, getManifest: async () => pendingJson, getChunk: store.getChunk.bind(store) };
    await expect(
      unpackResource({ mk, store: stuck as never, outPath: join(dir, "out.bin") }),
    ).rejects.toThrow(/尚未上传完成/);
    await rm(dir, { recursive: true, force: true });
  });

  test("parseManifest：pending 只接受 true", () => {
    const base = { version: 1, bundleId: "x", createdAt: "t", cipher: "AES-256-GCM", compression: "none", chunkSize: 1, wrappedKey: "w", chunks: [], encMeta: "e" };
    expect(parseManifest(JSON.stringify({ ...base, pending: true })).pending).toBe(true);
    expect(parseManifest(JSON.stringify(base)).pending).toBeUndefined();
    expect(() => parseManifest(JSON.stringify({ ...base, pending: false }))).toThrow(/pending/);
  });

  test("预览包先于分片上传，未完成 manifest 里已带预览信息，pending 期间 openPreview 可用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bz-pending-"));
    const file = join(dir, "v.mp4");
    await writeFile(file, Buffer.alloc(2048, 3));
    const { vault } = await createVault("pw pw pw pw 敝帚", { createdAt: "2026-09-06T00:00:00Z", params: LIGHT });
    const mk = await unlockWithPassword(vault, "pw pw pw pw 敝帚");
    const store = new MemoryBundleStore(generateBundleId());
    const order: string[] = [];
    const origPut = store.putManifest.bind(store);
    const origPrev = store.putPreview.bind(store);
    const origChunk = store.putChunk.bind(store);
    let pendingJson = "";
    store.putManifest = async (json: string) => { order.push("manifest"); if (!pendingJson) pendingJson = json; await origPut(json); };
    store.putPreview = async (d: Buffer) => { order.push("preview"); await origPrev(d); };
    store.putChunk = async (seq: number, d: Buffer) => { order.push(`chunk${seq}`); await origChunk(seq, d); };
    await packResource({ filePath: file, fileSize: 2048, mk, bundleId: store.bundleId, createdAt: "2026-09-06T00:00:00Z", chunkSize: 1024, store, preview: { kind: "image", data: Buffer.from("jpg!") } });
    expect(order.slice(0, 3)).toEqual(["preview", "manifest", "chunk0"]);
    expect(parseManifest(pendingJson).preview?.kind).toBe("image");
    const stuck = { ...store, bundleId: store.bundleId, getManifest: async () => pendingJson, getPreview: store.getPreview.bind(store) };
    const { openPreview } = await import("../src/resource/index.ts");
    const p = await openPreview(mk, stuck as never);
    expect(p.data.toString()).toBe("jpg!");
    await rm(dir, { recursive: true, force: true });
  });
});
