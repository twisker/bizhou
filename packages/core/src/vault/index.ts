/**
 * Vault（保险库）：管理"主密钥 MK"及其两条解锁路径。
 *
 * 密钥架构（对 PRD §7 信封加密的稳健化落地，AI 自主定稿并记入 tech-spec）：
 *
 *   主密码 ──scrypt──▶ KEK_pw ─┐
 *                               ├─包裹─▶  MK（随机主密钥）──包裹─▶ 各资源 DEK
 *   恢复密钥(32B 随机) = KEK_rk ─┘
 *
 * - MK 只随机生成一次；每个资源 DEK 由 MK 包裹后存入该资源 manifest.wrappedKey。
 * - MK 被"主密码派生的 KEK_pw"和"恢复密钥 KEK_rk"各包裹一份，存 vault 文件。
 * - 好处：改主密码只需重新包裹 MK，无需改动任何资源 manifest；忘主密码用恢复密钥解 MK。
 * - vault 文件存本地配置目录，绝不上传云端。恢复密钥仅在 init 时展示一次，用户离线保管。
 *
 * 没有主密码或恢复密钥，任何人都解不开 MK → 解不开任何 DEK → 读不到内容。真端到端。
 */

import {
  DEFAULT_SCRYPT,
  deriveKey,
  generateKey,
  generateSalt,
  KEY_BYTES,
  openFromBase64,
  type ScryptParams,
  sealToBase64,
  unwrapKey,
  wrapKey,
} from "../crypto/index.ts";
import { base32Decode, base32Encode, groupBase32 } from "../crypto/base32.ts";
import { AuthError, VaultError } from "../errors.ts";

/** 用于校验解锁得到的 MK 是否正确的固定标记。 */
const MK_CHECK_MARKER = Buffer.from("bizhou-vault-check-v1", "utf8");

export const VAULT_VERSION = 1 as const;

/** vault 文件结构（存本地配置目录，不入云端、不入库）。 */
export interface VaultFile {
  readonly version: typeof VAULT_VERSION;
  readonly kdf: ScryptParams;
  /** 主密码 KDF 用盐（base64）。 */
  readonly pwSalt: string;
  /** MK 被 KEK_pw 包裹（base64 blob）。 */
  readonly wrappedMkByPassword: string;
  /** MK 被恢复密钥包裹（base64 blob）。 */
  readonly wrappedMkByRecovery: string;
  /** 固定标记被 MK 加密，用于校验解锁得到的 MK 正确。 */
  readonly mkCheck: string;
  readonly createdAt: string;
}

export interface CreateVaultResult {
  readonly vault: VaultFile;
  /** 恢复密钥（base32，分组连字符）。只展示一次，务必离线保管。 */
  readonly recoveryKey: string;
}

function makeMkCheck(mk: Buffer): string {
  return sealToBase64(mk, MK_CHECK_MARKER);
}

function verifyMk(vault: VaultFile, mk: Buffer): void {
  let opened: Buffer;
  try {
    opened = openFromBase64(mk, vault.mkCheck);
  } catch (cause) {
    throw new VaultError("vault 校验失败：解锁得到的主密钥无法验证（vault 文件可能损坏）", {
      cause,
    });
  }
  if (!opened.equals(MK_CHECK_MARKER)) {
    throw new VaultError("vault 校验失败：主密钥标记不匹配");
  }
}

/**
 * 初始化 vault：生成 MK 与恢复密钥，用主密码与恢复密钥各包裹一份 MK。
 * 传入的 createdAt 由调用方提供（核心库不读时钟，保持纯函数、可测）。
 */
export async function createVault(
  masterPassword: string,
  opts: { createdAt: string; params?: ScryptParams } = { createdAt: "" },
): Promise<CreateVaultResult> {
  if (masterPassword.length === 0) {
    throw new VaultError("主密码不能为空");
  }
  const params = opts.params ?? DEFAULT_SCRYPT;
  const mk = generateKey();
  const pwSalt = generateSalt();
  const kekPw = await deriveKey(masterPassword, pwSalt, params);
  const recoveryRaw = generateKey(); // 32 字节高熵，直接用作 KEK_rk
  const recoveryKey = groupBase32(base32Encode(recoveryRaw));

  const vault: VaultFile = {
    version: VAULT_VERSION,
    kdf: params,
    pwSalt: pwSalt.toString("base64"),
    wrappedMkByPassword: wrapKey(kekPw, mk),
    wrappedMkByRecovery: wrapKey(recoveryRaw, mk),
    mkCheck: makeMkCheck(mk),
    createdAt: opts.createdAt,
  };
  return { vault, recoveryKey };
}

/** 用主密码解锁，返回 MK。密码错误因 GCM tag 失败抛 AuthError。 */
export async function unlockWithPassword(vault: VaultFile, masterPassword: string): Promise<Buffer> {
  const pwSalt = Buffer.from(vault.pwSalt, "base64");
  const kekPw = await deriveKey(masterPassword, pwSalt, vault.kdf);
  let mk: Buffer;
  try {
    mk = unwrapKey(kekPw, vault.wrappedMkByPassword);
  } catch (cause) {
    throw new AuthError("主密码错误：无法解开主密钥", { cause });
  }
  verifyMk(vault, mk);
  return mk;
}

/** 用恢复密钥解锁，返回 MK。 */
export async function unlockWithRecovery(vault: VaultFile, recoveryKey: string): Promise<Buffer> {
  const raw = base32Decode(recoveryKey);
  if (raw.length !== KEY_BYTES) {
    throw new AuthError(`恢复密钥长度不正确（应解出 ${KEY_BYTES} 字节，实际 ${raw.length}）`);
  }
  let mk: Buffer;
  try {
    mk = unwrapKey(raw, vault.wrappedMkByRecovery);
  } catch (cause) {
    throw new AuthError("恢复密钥错误：无法解开主密钥", { cause });
  }
  verifyMk(vault, mk);
  return mk;
}

/**
 * 改主密码：用当前主密码解出 MK，再用新主密码（新盐）重新包裹。
 * 恢复密钥保持不变。返回新的 vault 文件。
 */
export async function changePassword(
  vault: VaultFile,
  currentPassword: string,
  newPassword: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<VaultFile> {
  if (newPassword.length === 0) throw new VaultError("新主密码不能为空");
  const mk = await unlockWithPassword(vault, currentPassword);
  const pwSalt = generateSalt();
  const kekPw = await deriveKey(newPassword, pwSalt, params);
  return {
    ...vault,
    kdf: params,
    pwSalt: pwSalt.toString("base64"),
    wrappedMkByPassword: wrapKey(kekPw, mk),
  };
}

/** 用 MK 包裹资源 DEK（存入 manifest.wrappedKey）。 */
export function wrapDek(mk: Buffer, dek: Buffer): string {
  return wrapKey(mk, dek);
}

/** 用 MK 解开资源 DEK。 */
export function unwrapDek(mk: Buffer, wrapped: string): Buffer {
  return unwrapKey(mk, wrapped);
}
