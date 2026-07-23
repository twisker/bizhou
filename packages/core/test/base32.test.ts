import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { base32Decode, base32Encode, groupBase32 } from "../src/crypto/base32.ts";
import { InvalidArgError } from "../src/errors.ts";

describe("base32", () => {
  test("RFC4648 已知向量", () => {
    // "foobar" → MZXW6YTBOI
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });

  test("空输入", () => {
    expect(base32Encode(Buffer.alloc(0))).toBe("");
    expect(base32Decode("").length).toBe(0);
  });

  test("随机 32 字节往返一致（1000 次）", () => {
    for (let i = 0; i < 1000; i++) {
      const data = randomBytes(32);
      expect(base32Decode(base32Encode(data)).equals(data)).toBe(true);
    }
  });

  test("解码忽略连字符/空白/大小写", () => {
    const enc = base32Encode(Buffer.from("hello world"));
    const grouped = groupBase32(enc).toLowerCase();
    expect(base32Decode(grouped).toString()).toBe("hello world");
  });

  test("非法字符抛 InvalidArgError（含 0/1）", () => {
    expect(() => base32Decode("ABC0")).toThrow(InvalidArgError);
    expect(() => base32Decode("A1BC")).toThrow(InvalidArgError);
  });

  test("groupBase32 分组", () => {
    expect(groupBase32("ABCDEFGH", 4)).toBe("ABCD-EFGH");
  });
});
