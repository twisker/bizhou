/**
 * 联网集成测试（默认跳过）。当操作者提供真实 token 时执行真实百度往返：
 *   BIZHOU_LIVE=1 BAIDU_ACCESS_TOKEN=<token> bun test baidu.live
 * 这是 M0 关键验证的自动化形态：真实上传→下载→字节级一致。
 * 无 token 时静默跳过（CI 与本机默认不联网）。
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaiduBundleStore, type HttpClient } from "../src/baidu/index.ts";
import { BaiduClient } from "../src/baidu/client.ts";
import { generateBundleId } from "../src/bundle/index.ts";
import { packResource, unpackResource } from "../src/resource/index.ts";
import { createVault, unlockWithPassword } from "../src/vault/index.ts";

const LIVE = process.env.BIZHOU_LIVE === "1" && !!process.env.BAIDU_ACCESS_TOKEN;

const http: HttpClient = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<HttpClient>;

describe("Baidu 联网往返（M0 关键验证）", () => {
  test.skipIf(!LIVE)("真实上传→下载→字节级一致", async () => {
    const token = process.env.BAIDU_ACCESS_TOKEN!;
    const sizeMb = Number(process.env.BIZHOU_LIVE_SIZE_MB ?? 20);
    const client = new BaiduClient({ appKey: "", secretKey: "" }, token, http);

    const { vault } = await createVault("live-pass", {
      createdAt: "2026-07-23T00:00:00Z",
      params: { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 },
    });
    const mk = await unlockWithPassword(vault, "live-pass");

    const bundleId = generateBundleId();
    const store = new BaiduBundleStore(client, bundleId);
    const work = await mkdtemp(join(tmpdir(), "bizhou-live-"));
    try {
      const inPath = join(work, "live.bin");
      const outPath = join(work, "out.bin");
      const data = randomBytes(sizeMb * 1024 * 1024);
      await writeFile(inPath, data);
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

      await packResource({
        filePath: inPath,
        fileSize: data.length,
        mk,
        bundleId,
        createdAt: "2026-07-23T00:00:00Z",
        chunkSize: 100 * 1024 * 1024,
        compression: "none",
        store,
        name: "live.bin",
      });
      await unpackResource({ mk, store, outPath });
      expect(sha(await readFile(outPath))).toBe(sha(data));

      await store.remove(); // 清理云端测试资源
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
