import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const outDir = join(work, "out-sub");
    await cmdPull(rt, id, { local: store, out: outDir }); // 完整 id 取子目录 bundle
    const restored = await readFile(join(outDir, "深藏.bin"));
    expect(sha256(restored)).toBe(sha256(data));

    await cmdInfo(rt, id.slice(0, 12), { local: store }); // 12 位前缀跨子目录解析，不应抛错

    await cmdRm(rt, id.slice(0, 12), { local: store }); // 前缀删除成功
  });
});
