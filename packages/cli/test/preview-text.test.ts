import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStrategy, genText } from "../src/preview.ts";

describe("detectStrategy", () => {
  test("扩展名 → 策略", () => {
    expect(detectStrategy("a.txt")).toBe("text");
    expect(detectStrategy("a.md")).toBe("text");
    expect(detectStrategy("a.ts")).toBe("text");
    expect(detectStrategy("a.pdf")).toBe("pdf");
    expect(detectStrategy("a.zip")).toBe("archive");
    expect(detectStrategy("a.tar.gz")).toBe("archive");
    expect(detectStrategy("a.mp4")).toBe("video");
    expect(detectStrategy("a.jpg")).toBe("image");
    expect(detectStrategy("a.unknownxyz")).toBeNull();
  });
});

describe("genText", () => {
  test("前 32KB 截断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt-"));
    try {
      const big = "x".repeat(50 * 1024);
      const p = join(dir, "big.txt");
      await writeFile(p, big, "utf8");
      const r = await genText(p);
      expect(r?.kind).toBe("text");
      expect(r?.data.length).toBe(32 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("UTF-8 多字节跨 32KB 边界 → 截到完整字符、解码无乱码", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt2-"));
    try {
      // 填充到 32KB 边界附近落在一个 3 字节中文中间
      const pad = "a".repeat(32 * 1024 - 1); // 边界前 1 字节
      const content = `${pad}中文尾`; // '中' 从第 32K-1 字节开始，跨界
      const p = join(dir, "u.txt");
      await writeFile(p, content, "utf8");
      const r = await genText(p);
      const decoded = r!.data.toString("utf8");
      expect(decoded).not.toContain("�"); // 无替换字符（无半个字）
      expect(r!.data.length).toBeLessThanOrEqual(32 * 1024); // 砍到边界
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("空文件 → 空 buffer（仍是合法预览）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ptxt3-"));
    try {
      const p = join(dir, "empty.txt");
      await writeFile(p, "");
      const r = await genText(p);
      expect(r?.data.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
