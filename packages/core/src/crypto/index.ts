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
  createHmac,
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
 * 默认 scrypt 参数。
 *
 * N=2^17（128 MiB）—— v1.1.0 起提升自 2^15（32 MiB）。起因：v1.1.0 把 vault 加密上云，
 * 云服务商直接持有密文，可离线、无频率限制地爆破主密码；2^15 是"交互式登录"档位，只
 * 适合"文件不出设备"的旧威胁模型。N 每 +1 bit 使攻击者单次猜测的时间与内存成本各 ×2；
 * 4× 提升下，合法用户的解锁成本（每台设备一次）多花约 0.3–0.5s，攻击者的离线爆破成本
 * 同比例升高——这是本代码库里最便宜的一次安全加固。
 *
 * 向前兼容是这次调参能落地的关键：kdf 参数记在每个 vault 文件内（`VaultFile.kdf`），
 * `unlockWithPassword`/`unlockWithRecovery` 派生时用的是 `vault.kdf`，不是这个常量——
 * 老 vault（N=2^15）永远用自己那份参数解锁，不受这里上调影响；只有新建的 vault 才会
 * 采用新默认值。参见 packages/core/src/vault/index.ts 的 unlockWithPassword。
 */
export const DEFAULT_SCRYPT: ScryptParams = {
  algo: "scrypt",
  N: 1 << 17,
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

/**
 * 由 key 与一段唯一上下文（如 chunkAad = bundleId||seq）确定性派生 12B GCM IV。
 *
 * 用途：断点续传要求"跳过重传的分片"其 manifest 记录（iv/tag/sha256）必须与云端已存密文
 * 逐字节一致。随机 IV 会让续传时重新加密同一分片得到不同密文，与已上传密文不符 → pull 校验失败。
 * 以 HMAC-SHA256(key, context) 截断为 IV，使"同 key + 同上下文 + 同明文"必得同一密文。
 *
 * 安全不变量（GCM 要求：绝不用同一 (key, IV) 加密不同明文）：
 *  (a) key=DEK，每个新 bundle 由 CSPRNG 随机生成，互不相同；
 *  (b) aad = "bundleId:seq"，同一 bundle 内每个分片唯一 → 同一 DEK 下每个 seq 的 IV 唯一；
 *  (c) 续传时 DEK、bundleId、chunkSize、compression 全部从 journal 固定还原（见
 *      JournalEntry 与 pushOneFile），故 seq→明文的映射与首次完全一致，重加密逐字节可复现。
 * 三者合起来：唯一可能重复的 (key, IV) 组合只出现在"续传重算同一 seq"这一情形，而此时明文
 * 必然与首次相同（(a)(c) 保证），属同一 (key, IV, 明文) 的幂等重算，不是 nonce 复用。
 *
 * 反例警示（历史漏洞）：若续传时改用不同的 chunkSize 或 compression，则同一 seq 覆盖不同明文，
 * (key, IV) 相同而明文不同 → 灾难性 nonce 复用（机密性击穿 + GHASH/tag 伪造）。故上述 (c) 的
 * chunkSize/compression 固定是本方案安全的前提，绝不可仅凭 contentId 判定"文件未变"而放松。
 * IV 无需保密，唯一即可。
 */
export function deriveDeterministicIv(key: Buffer, context: Buffer): Buffer {
  return createHmac("sha256", key).update(context).digest().subarray(0, IV_BYTES);
}

/**
 * 用 AES-256-GCM 加密。可选 AAD（附加认证数据，参与完整性校验但不加密）。
 * 可选 iv：不传则用 CSPRNG 随机 IV；传入（须 12B）则用确定性 IV（供续传逐字节复现，见
 * `deriveDeterministicIv`）。调用方须自行保证 (key, iv) 唯一。
 */
export function aeadEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer, iv?: Buffer): AeadResult {
  assertKey(key);
  if (iv && iv.length !== IV_BYTES) throw new CryptoError(`IV 长度必须为 ${IV_BYTES} 字节`);
  const nonce = iv ?? randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGO, key, nonce, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: nonce, ciphertext, tag };
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
