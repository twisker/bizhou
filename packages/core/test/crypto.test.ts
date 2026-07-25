import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { AuthError, CryptoError } from "../src/errors.ts";
import {
  aeadDecrypt,
  aeadEncrypt,
  DEFAULT_SCRYPT,
  deriveDeterministicIv,
  deriveKey,
  generateKey,
  generateSalt,
  IV_BYTES,
  KEY_BYTES,
  openFromBase64,
  packAead,
  sealToBase64,
  TAG_BYTES,
  unpackAead,
  unwrapKey,
  wrapKey,
} from "../src/crypto/index.ts";

describe("AEAD (AES-256-GCM)", () => {
  test("encrypt→decrypt 往返一致", () => {
    const key = generateKey();
    const plaintext = Buffer.from("敝帚：客户端加密，隐私优先 🛡️", "utf8");
    const { iv, ciphertext, tag } = aeadEncrypt(key, plaintext);
    expect(iv.length).toBe(IV_BYTES);
    expect(tag.length).toBe(TAG_BYTES);
    expect(ciphertext.equals(plaintext)).toBe(false); // 确实被加密
    const back = aeadDecrypt(key, iv, ciphertext, tag);
    expect(back.equals(plaintext)).toBe(true);
  });

  test("空明文也能往返", () => {
    const key = generateKey();
    const r = aeadEncrypt(key, Buffer.alloc(0));
    expect(aeadDecrypt(key, r.iv, r.ciphertext, r.tag).length).toBe(0);
  });

  test("大随机数据往返一致（1MB）", () => {
    const key = generateKey();
    const data = randomBytes(1024 * 1024);
    const r = aeadEncrypt(key, data);
    expect(aeadDecrypt(key, r.iv, r.ciphertext, r.tag).equals(data)).toBe(true);
  });

  test("每次加密的 IV 不同（不重用 nonce）", () => {
    const key = generateKey();
    const a = aeadEncrypt(key, Buffer.from("x"));
    const b = aeadEncrypt(key, Buffer.from("x"));
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  test("篡改密文 → 抛 AuthError，绝不静默返回损坏数据", () => {
    const key = generateKey();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("secret payload"));
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => aeadDecrypt(key, iv, tampered, tag)).toThrow(AuthError);
  });

  test("篡改 tag → 抛 AuthError", () => {
    const key = generateKey();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("secret"));
    const badTag = Buffer.from(tag);
    badTag[0] = badTag[0]! ^ 0x01;
    expect(() => aeadDecrypt(key, iv, ciphertext, badTag)).toThrow(AuthError);
  });

  test("错误密钥 → 抛 AuthError", () => {
    const { iv, ciphertext, tag } = aeadEncrypt(generateKey(), Buffer.from("secret"));
    expect(() => aeadDecrypt(generateKey(), iv, ciphertext, tag)).toThrow(AuthError);
  });

  test("AAD 不匹配 → 抛 AuthError", () => {
    const key = generateKey();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("m"), Buffer.from("aad-1"));
    expect(() => aeadDecrypt(key, iv, ciphertext, tag, Buffer.from("aad-2"))).toThrow(AuthError);
    // 正确 AAD 可解
    expect(aeadDecrypt(key, iv, ciphertext, tag, Buffer.from("aad-1")).toString()).toBe("m");
  });

  test("错误长度密钥 → 抛 CryptoError", () => {
    expect(() => aeadEncrypt(Buffer.alloc(16), Buffer.from("x"))).toThrow(CryptoError);
  });
});

describe("deriveDeterministicIv（确定性分片 IV）", () => {
  test("确定性：同 key + 同 context → 同一 IV", () => {
    const key = generateKey();
    const ctx = Buffer.from("bundle-abc:3", "utf8");
    expect(deriveDeterministicIv(key, ctx).equals(deriveDeterministicIv(key, ctx))).toBe(true);
  });

  test("长度恒为 12 字节（GCM 96-bit IV）", () => {
    expect(deriveDeterministicIv(generateKey(), Buffer.from("x")).length).toBe(IV_BYTES);
  });

  test("按 seq 唯一：同 key 不同 context（seq） → 不同 IV", () => {
    const key = generateKey();
    const iv0 = deriveDeterministicIv(key, Buffer.from("b:0", "utf8"));
    const iv1 = deriveDeterministicIv(key, Buffer.from("b:1", "utf8"));
    const iv2 = deriveDeterministicIv(key, Buffer.from("b:2", "utf8"));
    expect(iv0.equals(iv1)).toBe(false);
    expect(iv1.equals(iv2)).toBe(false);
    expect(iv0.equals(iv2)).toBe(false);
  });

  test("跨 DEK 差异：不同 key + 同 context → 不同 IV", () => {
    const ctx = Buffer.from("b:0", "utf8");
    expect(deriveDeterministicIv(generateKey(), ctx).equals(deriveDeterministicIv(generateKey(), ctx))).toBe(false);
  });
});

describe("AEAD blob 序列化", () => {
  test("pack→unpack 往返", () => {
    const key = generateKey();
    const r = aeadEncrypt(key, Buffer.from("hello"));
    const u = unpackAead(packAead(r));
    expect(u.iv.equals(r.iv)).toBe(true);
    expect(u.tag.equals(r.tag)).toBe(true);
    expect(u.ciphertext.equals(r.ciphertext)).toBe(true);
  });

  test("sealToBase64→openFromBase64 往返", () => {
    const key = generateKey();
    const b64 = sealToBase64(key, Buffer.from("信封"));
    expect(typeof b64).toBe("string");
    expect(openFromBase64(key, b64).toString("utf8")).toBe("信封");
  });

  test("过短 blob → 抛 CryptoError", () => {
    expect(() => unpackAead(Buffer.alloc(4))).toThrow(CryptoError);
  });
});

describe("KDF (scrypt) + 密钥包裹", () => {
  test("同密码+盐+参数派生结果确定且等长", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("correct horse battery staple", salt);
    const k2 = await deriveKey("correct horse battery staple", salt);
    expect(k1.length).toBe(KEY_BYTES);
    expect(k1.equals(k2)).toBe(true);
  });

  test("不同盐 → 不同 KEK", async () => {
    const a = await deriveKey("pw", generateSalt());
    const b = await deriveKey("pw", generateSalt());
    expect(a.equals(b)).toBe(false);
  });

  test("密码 NFKC 归一化：等价 Unicode 表示派生一致", async () => {
    const salt = generateSalt();
    // "é" 组合字符 (e + U+0301) vs 预组合 (U+00E9)
    const combining = await deriveKey("café", salt);
    const precomposed = await deriveKey("café", salt);
    expect(combining.equals(precomposed)).toBe(true);
  });

  test("wrapKey→unwrapKey 往返（信封）", async () => {
    const kek = await deriveKey("master-pass", generateSalt());
    const dek = generateKey();
    const wrapped = wrapKey(kek, dek);
    expect(unwrapKey(kek, wrapped).equals(dek)).toBe(true);
  });

  test("错误主密码 unwrap → 抛 AuthError", async () => {
    const salt = generateSalt();
    const kek = await deriveKey("right-pass", salt);
    const wrong = await deriveKey("wrong-pass", salt);
    const wrapped = wrapKey(kek, generateKey());
    expect(() => unwrapKey(wrong, wrapped)).toThrow(AuthError);
  });

  test("params.N 更高时仍可派生（内存上限已放宽）", async () => {
    const salt = generateSalt();
    const k = await deriveKey("pw", salt, { ...DEFAULT_SCRYPT, N: 1 << 16 });
    expect(k.length).toBe(KEY_BYTES);
  });

  // E-3：vault 上云后，云服务商直接持有密文、可离线无限次爆破主密码（无频率限制）。
  // 2^15（交互式登录档）对"文件不出设备"场景合理，但不足以抵御离线爆破，须提到 2^17（128 MiB）。
  test("DEFAULT_SCRYPT.N 已提升至 2^17（应对云端离线爆破的威胁模型）", () => {
    expect(DEFAULT_SCRYPT.N).toBe(1 << 17);
  });

  test("新参数下仍可正常派生密钥，且 maxmem 留有余量不因 N 提升而触顶", async () => {
    const salt = generateSalt();
    const k = await deriveKey("pw", salt, DEFAULT_SCRYPT);
    expect(k.length).toBe(KEY_BYTES);
  });
});
