/**
 * RFC 4648 base32（大写、无填充）编解码。
 * 用于把 32 字节恢复密钥编码成人类可誊写的字符串（避免 0/O、1/l 之类混淆——
 * base32 字母表本身不含 0/1/8/9）。
 */
import { InvalidArgError } from "../errors.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CHAR_TO_VAL: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) CHAR_TO_VAL[ALPHABET[i]!] = i;

/** 编码为 base32（无填充）。 */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * 解码 base32。忽略连字符、空白与大小写，便于用户誊写时用分组连字符。
 * 非法字符抛 InvalidArgError。
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[-\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const v = CHAR_TO_VAL[ch];
    if (v === undefined) {
      throw new InvalidArgError(`base32 含非法字符：'${ch}'`);
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 把 base32 字符串按每 groupSize 个字符插入连字符，便于誊写。 */
export function groupBase32(s: string, groupSize = 4): string {
  const groups: string[] = [];
  for (let i = 0; i < s.length; i += groupSize) {
    groups.push(s.slice(i, i + groupSize));
  }
  return groups.join("-");
}
