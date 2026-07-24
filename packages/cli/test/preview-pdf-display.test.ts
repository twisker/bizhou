import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genPdf } from "../src/preview.ts";

describe("genPdf 降级", () => {
  test("pdftoppm 不可用（指向不存在的 bin）→ null，不抛", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-ppdf-"));
    const prev = process.env.BIZHOU_PDFTOPPM_BIN;
    try {
      process.env.BIZHOU_PDFTOPPM_BIN = "/nonexistent/pdftoppm-xyz";
      const p = join(dir, "a.pdf");
      await writeFile(p, Buffer.from("%PDF-1.4 fake")); // 内容无所谓，bin 不存在即降级
      expect(await genPdf(p)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.BIZHOU_PDFTOPPM_BIN;
      else process.env.BIZHOU_PDFTOPPM_BIN = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
