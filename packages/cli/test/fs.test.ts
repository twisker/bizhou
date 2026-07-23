import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdInfo,
  cmdInit,
  cmdLs,
  cmdMkdir,
  cmdPull,
  cmdPush,
  cmdRm,
  createRuntime,
} from "../src/commands.ts";

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

let work: string;
let store: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "bizhou-fs-"));
  store = join(work, "store");
  process.env.BIZHOU_HOME = join(work, "home");
  process.env.BIZHOU_MASTER_PASSWORD = "fs-pass";
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.BIZHOU_HOME;
  delete process.env.BIZHOU_MASTER_PASSWORD;
});

describe("mkdir + ls（本地后端）", () => {
  test("mkdir 建目录；push 到子目录；ls 显示子目录与真名；ls -r 递归", async () => {
    const rt = createRuntime();
    await cmdInit(rt, {});
    await cmdMkdir(rt, "/工作/2026", { local: store });

    const f = join(work, "报告.pdf");
    await writeFile(f, Buffer.from("hello"));
    await cmdPush(rt, f, { local: store, to: "/工作/2026", name: "报告.pdf" });

    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      lines.push(String(s));
      return true;
    };
    try {
      await cmdLs(rt, "/工作", { local: store }); // 应列出子目录 2026
      await cmdLs(rt, "/工作/2026", { local: store }); // 应显示 报告.pdf
      await cmdLs(rt, "/", { local: store, recursive: true }); // 递归含 报告.pdf
    } finally {
      process.stdout.write = orig;
    }
    const text = lines.join("");
    expect(text).toContain("2026");
    expect(text).toContain("报告.pdf");
  });

  test("子目录 bundle 可按完整 id / 12 位前缀 pull/info/rm", async () => {
    // --out 是相对文件根的子目录（pull 落地始终在 rt.fileRoot 之下），先设好文件根再建 rt
    const fileRoot = join(work, "froot-sub");
    process.env.BIZHOU_FILE_ROOT = fileRoot;
    try {
      const rt = createRuntime();

      const data = randomBytes(8192);
      const f = join(work, "深藏.bin");
      await writeFile(f, data);
      const id = await cmdPush(rt, f, {
        local: store,
        to: "/工作/2026",
        name: "深藏.bin",
      });
      expect(id).toMatch(/^[0-9a-f]{32}$/);

      await cmdPull(rt, id, { local: store, out: "out-sub" }); // 完整 id 取子目录 bundle
      const restored = await readFile(join(fileRoot, "out-sub", "深藏.bin"));
      expect(sha256(restored)).toBe(sha256(data));

      await cmdInfo(rt, id.slice(0, 12), { local: store }); // 12 位前缀跨子目录解析，不应抛错

      await cmdRm(rt, id.slice(0, 12), { local: store }); // 前缀删除成功
    } finally {
      delete process.env.BIZHOU_FILE_ROOT;
    }
  });
});

test("push 缺省云端目录按文件根镜像；pull 落文件根带入结构", async () => {
  const fr = join(work, "fileroot");
  await mkdir(join(fr, "工作", "2026"), { recursive: true });
  process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    const data = randomBytes(3000);
    const src = join(fr, "工作", "2026", "报告.bin");
    await writeFile(src, data);
    // 不给 --to：应镜像到 /工作/2026
    const id = await cmdPush(rt, src, { local: store, name: "报告.bin" });
    // 该 bundle 应在 /工作/2026 下（用 resolveBundle 间接验证：pull 能取回）
    await cmdPull(rt, id, { local: store });
    // pull 落文件根镜像位置
    const landed = join(fr, "工作", "2026", "报告.bin");
    expect(sha256(await readFile(landed))).toBe(sha256(data));
  } finally {
    delete process.env.BIZHOU_FILE_ROOT;
  }
});

test("push -r 递归上传目录树，pull -r 还原字节级一致", async () => {
  const fr = join(work, "fr2");
  process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    const treeDir = join(work, "tree");
    await mkdir(join(treeDir, "a", "b"), { recursive: true });
    const f1 = randomBytes(1000);
    const f2 = randomBytes(2000);
    await writeFile(join(treeDir, "root.bin"), f1);
    await writeFile(join(treeDir, "a", "b", "deep.bin"), f2);
    await cmdPush(rt, treeDir, { local: store, recursive: true, to: "/备份" });
    // pull -r 还原整棵树到文件根
    await cmdPull(rt, "/备份/tree", { local: store, recursive: true });
    expect(sha256(await readFile(join(fr, "备份", "tree", "root.bin")))).toBe(sha256(f1));
    expect(sha256(await readFile(join(fr, "备份", "tree", "a", "b", "deep.bin")))).toBe(
      sha256(f2),
    );
  } finally {
    delete process.env.BIZHOU_FILE_ROOT;
  }
});

test("push -r 不带 --to：缺省按文件根镜像目录位置", async () => {
  const fr = join(work, "fr3");
  process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    // 源目录在文件根下：fileRoot/收藏/tree2
    const treeDir = join(fr, "收藏", "tree2");
    await mkdir(join(treeDir, "sub"), { recursive: true });
    const f1 = randomBytes(800);
    await writeFile(join(treeDir, "sub", "x.bin"), f1);
    // 不给 --to：目录父(/收藏)镜像 + basename(tree2) → 云端 /收藏/tree2
    await cmdPush(rt, treeDir, { local: store, recursive: true });
    await cmdPull(rt, "/收藏/tree2", { local: store, recursive: true });
    expect(sha256(await readFile(join(fr, "收藏", "tree2", "sub", "x.bin")))).toBe(sha256(f1));
  } finally {
    delete process.env.BIZHOU_FILE_ROOT;
  }
});

test("push -r 对非目录报错", async () => {
  const f = join(work, "not-a-dir.bin");
  await writeFile(f, Buffer.from("x"));
  const rt = createRuntime();
  await expect(cmdPush(rt, f, { local: store, recursive: true })).rejects.toThrow();
});

test("pull --out 也净化恶意 meta.name，防 ../ 逃逸文件根", async () => {
  const fr = join(work, "fr-sec");
  process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    const data = randomBytes(500);
    const src = join(work, "sec-src.bin");
    await writeFile(src, data);
    // 恶意原文件名（模拟分享他人 bundle 时 encMeta.name 被构造为穿越串）
    const id = await cmdPush(rt, src, { local: store, name: "../../../../evil.bin" });
    await cmdPull(rt, id, { local: store, out: "sub" });
    // 应被 basename 净化，落在 fileRoot/sub/evil.bin，绝不逃逸
    expect(sha256(await readFile(join(fr, "sub", "evil.bin")))).toBe(sha256(data));
  } finally {
    delete process.env.BIZHOU_FILE_ROOT;
  }
});
