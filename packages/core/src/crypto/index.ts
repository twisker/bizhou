/**
 * 密码学原语：AES-256-GCM 信封加密 + scrypt KDF + 密钥包裹。
 *
 * 设计原则：
 * - 只用运行时内置 `node:crypto`（Bun/Node 通用），零外部二进制依赖，可审计。
 * - AEAD（GCM）同时保证机密性与完整性：tag 校验失败即抛 AuthError，绝不静默返回损坏数据。
 * - 所有随机数走 CSPRNG（randomBytes）。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { AuthError, CryptoError, InvalidArgError } from "../errors.ts";

const scryptAsync = promisify(scryptCallback) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// ---- 常量 ----------------------------------------------------------------

export const CIPHER_ALGO = "aes-256-gcm" as const;
export const KEY_BYTES = 32; // AES-256
export const IV_BYTES = 12; // GCM 推荐 96-bit IV
export const TAG_BYTES = 16; // GCM 认证标签
export const SALT_BYTES = 16;

/** scrypt KDF 参数。写入 vault/manifest，便于审计与将来调参。 */
export interface ScryptParams {
  readonly algo: "scrypt";
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

/**
 * 默认 scrypt 参数。N=2^15 属交互式登录的稳健档位；
 * 记入 vault 后可随硬件演进上调而不影响老数据（老数据用其自带参数解开）。
 */
export const DEFAULT_SCRYPT: ScryptParams = {
  algo: "scrypt",
  N: 1 << 15,
  r: 8,
  p: 1,
  keylen: KEY_BYTES,
};

// ---- AEAD（AES-256-GCM）--------------------------------------------------

export interface AeadResult {
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`密钥长度必须为 ${KEY_BYTES} 字节，实际 ${key.length}`);
  }
}

/** 用 AES-256-GCM 加密。可选 AAD（附加认证数据，参与完整性校验但不加密）。 */
export function aeadEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer): AeadResult {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext, tag };
}

/**
 * 用 AES-256-GCM 解密。tag 校验失败（内容被篡改/密钥错误/AAD 不匹配）时抛 AuthError。
 */
export function aeadDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer {
  assertKey(key);
  if (iv.length !== IV_BYTES) throw new CryptoError(`IV 长度必须为 ${IV_BYTES} 字节`);
  if (tag.length !== TAG_BYTES) throw new CryptoError(`tag 长度必须为 ${TAG_BYTES} 字节`);
  const decipher = createDecipheriv(CIPHER_ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new AuthError("解密失败：GCM 认证标签校验不通过（内容被篡改、密钥错误或 AAD 不匹配）", {
      cause,
    });
  }
}

// ---- AEAD blob 序列化 -----------------------------------------------------
// 紧凑格式： iv(12) || tag(16) || ciphertext。整体做 base64 存入 manifest/vault。

/** 把 AeadResult 打包为单个 Buffer： iv || tag || ciphertext。 */
export function packAead(r: AeadResult): Buffer {
  return Buffer.concat([r.iv, r.tag, r.ciphertext]);
}

/** 解包 packAead 的产物。长度不足即抛错。 */
export function unpackAead(blob: Buffer): AeadResult {
  const min = IV_BYTES + TAG_BYTES;
  if (blob.length < min) {
    throw new CryptoError(`AEAD blob 过短：至少 ${min} 字节，实际 ${blob.length}`);
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  return { iv, ciphertext, tag };
}

/** 加密并直接产出 base64 blob（iv||tag||ct）。 */
export function sealToBase64(key: Buffer, plaintext: Buffer, aad?: Buffer): string {
  return packAead(aeadEncrypt(key, plaintext, aad)).toString("base64");
}

/** 从 base64 blob 解密。 */
export function openFromBase64(key: Buffer, b64: string, aad?: Buffer): Buffer {
  const { iv, ciphertext, tag } = unpackAead(Buffer.from(b64, "base64"));
  return aeadDecrypt(key, iv, ciphertext, tag, aad);
}

// ---- KDF（scrypt）--------------------------------------------------------

export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * 由主密码（或恢复口令）经 scrypt 派生 32 字节密钥（KEK）。
 * 密码先做 NFKC 归一化，避免跨平台 Unicode 表示差异导致派生不一致。
 */
export async function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<Buffer> {
  if (params.algo !== "scrypt") {
    throw new InvalidArgError(`不支持的 KDF 算法：${String(params.algo)}`);
  }
  const pw = Buffer.from(password.normalize("NFKC"), "utf8");
  // maxmem 给足，避免 128*N*r 触顶默认上限。
  const maxmem = 256 * params.N * params.r + 1024 * 1024;
  const key = (await scryptAsync(pw, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  })) as Buffer;
  return key;
}

// ---- 随机密钥与密钥包裹 ---------------------------------------------------

/** 生成随机 AES-256 密钥（用作 DEK 或 vault 主密钥 MK）。 */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** 用 KEK 包裹（加密）一个密钥，产出 base64 blob。 */
export function wrapKey(kek: Buffer, key: Buffer): string {
  assertKey(key);
  return sealToBase64(kek, key);
}

/** 用 KEK 解包一个密钥。KEK 错误会因 GCM tag 失败而抛 AuthError。 */
export function unwrapKey(kek: Buffer, wrapped: string): Buffer {
  const key = openFromBase64(kek, wrapped);
  assertKey(key);
  return key;
}

/** 常量时间比较两段等长 Buffer（用于比对指纹等，避免时序侧信道）。 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
