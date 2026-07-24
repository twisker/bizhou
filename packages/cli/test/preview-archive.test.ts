import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genArchive } from "../src/preview.ts";

/** 造一个含两个文件头的最小 tar（每文件仅头 + 0 数据块，末尾两个零块）。 */
function makeTar(names: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const name of names) {
    const b = Buffer.alloc(512);
    b.write(name, 0, "utf8"); // name @0
    b.write("0000000\0", 124, "ascii"); // size octal = 0
    // 简化：不算 checksum（listTar 不校验 checksum）
    blocks.push(b);
  }
  blocks.push(Buffer.alloc(512)); // 两个零块结束
  blocks.push(Buffer.alloc(512));
  return Buffer.concat(blocks);
}

/** 造最小 zip：一个空文件条目 + 中央目录 + EOCD（只需能被中央目录解析出名字）。 */
function makeZip(names: string[]): Buffer {
  // 本地文件头 + 中央目录记录 + EOCD；数据长度 0。
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, "utf8");
    const lf = Buffer.alloc(30 + nameBuf.length);
    lf.writeUInt32LE(0x04034b50, 0);
    lf.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lf, 30);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cd, 46);
    locals.push(lf);
    centrals.push(cd);
    offset += lf.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 10); // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe("genArchive", () => {
  test("zip → 列出文件名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc-"));
    try {
      const p = join(dir, "a.zip");
      await writeFile(p, makeZip(["a.txt", "sub/b.txt"]));
      const r = await genArchive(p);
      const text = r!.data.toString("utf8");
      expect(text).toContain("a.txt");
      expect(text).toContain("sub/b.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tar.gz → 列出文件名（内置 zlib）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc2-"));
    try {
      const p = join(dir, "a.tar.gz");
      await writeFile(p, gzipSync(makeTar(["x/one", "x/two"])));
      const r = await genArchive(p);
      const text = r!.data.toString("utf8");
      expect(text).toContain("x/one");
      expect(text).toContain("x/two");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("损坏包 → null（不抛）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bizhou-parc3-"));
    try {
      const p = join(dir, "bad.zip");
      await writeFile(p, Buffer.from("not a zip at all"));
      expect(await genArchive(p)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
