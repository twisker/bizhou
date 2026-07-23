import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapDek } from "@bizhou/core";
import {
  cmdInfo,
  cmdInit,
  cmdLs,
  cmdPull,
  cmdPush,
  cmdRm,
  cmdShare,
  createRuntime,
  parseSize,
  parseShareCode,
} from "../src/commands.ts";
import { findSevenZip } from "../src/export7z.ts";

let work: string;
let localStore: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "bizhou-cli-"));
  localStore = join(work, "store");
  process.env.BIZHOU_CONFIG_DIR = join(work, "cfg");
  process.env.BIZHOU_MASTER_PASSWORD = "cli-test-pass";
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.BIZHOU_CONFIG_DIR;
  delete process.env.BIZHOU_MASTER_PASSWORD;
});

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("parseSize", () => {
  test("单位解析", () => {
    expect(parseSize("1024")).toBe(1024);
    expect(parseSize("4MB")).toBe(4 * 1024 ** 2);
    expect(parseSize("100mb")).toBe(100 * 1024 ** 2);
    expect(parseSize("2G")).toBe(2 * 1024 ** 3);
    expect(parseSize("1.5kb")).toBe(1536);
  });
  test("非法输入抛错", () => {
    expect(() => parseSize("abc")).toThrow();
  });
});

describe("CLI 命令（离线 --local，真实命令代码）", () => {
  test("init → push → ls/info → pull 字节级一致 → rm", async () => {
    const rt = createRuntime();
    await cmdInit(rt, {});

    const data = randomBytes(2_500_000); // 多片
    const inPath = join(work, "secret.bin");
    await writeFile(inPath, data);

    const id = await cmdPush(rt, inPath, {
      local: localStore,
      chunk: "1MB",
      name: "私密.bin",
    });
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    // ls / info 不抛错
    await cmdLs(rt, undefined, { local: localStore });
    await cmdInfo(rt, id, { local: localStore });

    const outDir = join(work, "out");
    await cmdPull(rt, id, { local: localStore, out: outDir });
    const restored = await readFile(join(outDir, "私密.bin"));
    expect(sha256(restored)).toBe(sha256(data)); // 字节级一致

    await cmdRm(rt, id, { local: localStore });
  });

  test("share --code 导出的 DEK 能解开该资源 manifest 的 wrappedKey", async () => {
    const rt = createRuntime();
    const inPath = join(work, "share.bin");
    const data = randomBytes(4096);
    await writeFile(inPath, data);
    const id = await cmdPush(rt, inPath, { local: localStore, name: "share.bin" });

    // 捕获 share --code 打印的分享码
    const printed: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      printed.push(String(s));
      return true;
    };
    try {
      await cmdShare(rt, id, { local: localStore, code: true });
    } finally {
      process.stdout.write = origWrite;
    }
    const shareCode = printed.join("").split("\n").find((l) => l.includes("BZK1-"))!.trim();
    const dek = parseShareCode(shareCode.replace(/\x1b\[[0-9;]*m/g, "")); // 去除 ANSI

    // 用 share 出来的 DEK 直接解 manifest 的 wrappedKey 应等于同一 DEK
    const manifestJson = await readFile(join(localStore, `${id}.bz`, "manifest.json"), "utf8");
    const wrappedKey = JSON.parse(manifestJson).wrappedKey as string;
    // 用 rt 的 MK 解出 DEK，应与分享码一致
    const mk = await rt.resolveMk({});
    const dekViaMk = unwrapDek(mk, wrappedKey);
    expect(dek.equals(dekViaMk)).toBe(true);
  });

  test("share --7z 导出的包能被第三方 7z 用密码解密（有 7z 时运行）", async () => {
    const bin = await findSevenZip();
    if (!bin) {
      console.log("  ↷ 跳过：本机未安装 7z（安装 p7zip 后此测试验证第三方解密）");
      return;
    }
    const rt = createRuntime();
    const inPath = join(work, "doc.bin");
    const data = randomBytes(20_000);
    await writeFile(inPath, data);
    const id = await cmdPush(rt, inPath, { local: localStore, name: "机密文档.bin" });

    const outDir = join(work, "7z");
    process.env.BIZHOU_SHARE_PASSWORD = "share-pw-123";
    try {
      await cmdShare(rt, id, { local: localStore, sevenz: true, out: outDir });
    } finally {
      delete process.env.BIZHOU_SHARE_PASSWORD;
    }
    const archive = join(outDir, "机密文档.bin.7z");

    // 用第三方 7z 解密提取，校验字节一致
    const extractDir = join(work, "7z-extract");
    const r = spawnSync(bin, ["x", "-p" + "share-pw-123", "-o" + extractDir, "-y", "--", archive], {
      stdio: "ignore",
    });
    expect(r.status).toBe(0);
    const extracted = await readFile(join(extractDir, "机密文档.bin"));
    expect(sha256(extracted)).toBe(sha256(data));

    // 头部加密：错误密码应无法列出/解出
    const bad = spawnSync(bin, ["t", "-p" + "wrong-pw", "--", archive], { stdio: "ignore" });
    expect(bad.status).not.toBe(0);
  });
});
