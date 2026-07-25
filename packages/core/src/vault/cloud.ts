/**
 * 云端保险库（E-2 + E-4）：把 vault 文件放到云端，使"换机只需重输主密码"第一次真正成立。
 *
 * 为什么可以直接把 vault 原样上传、不做二次加密：
 * vault 文件本身就是一个密文信封——里面只有 `wrapKey(KEK_pw, MK)` 与 `wrapKey(KEK_rk, MK)`
 * 两份密文、KDF 参数与盐。没有主密码或恢复密钥，谁也解不开 MK，因而解不开任何资源 DEK。
 * 再套一层加密只会引入"这层的密钥存哪"的循环问题。
 *
 * ⚠️ **上云改变了威胁模型，这是一次自觉的交易。**
 * 上云前，攻击者必须先拿到用户的设备才能碰到 vault；上云后，云服务商直接持有这份密文，
 * 可以离线、无频率限制地爆破主密码。换来的是可恢复性：设备丢了、坏了、换新机，用户
 * 只凭主密码就能拿回全部数据（此前必须自己备份 vault 文件，实际上没人会做，
 * 后果是数据永久锁死）。这笔交易的定价完全由**主密码强度**决定——因此上云路径上的
 * 强度校验是硬关卡，不是可跳过的提示（见 CLI 的 assertStrongEnough）。
 */

import type { Backend } from "../backend/index.ts";
import { CLOUD_VAULT_NAME } from "../backend/reserved.ts";
import { VaultError } from "../errors.ts";
import { VAULT_VERSION, type VaultFile } from "./index.ts";

/** 云端保险库的固定路径（云端根目录下，不透明命名；见 CLOUD_VAULT_NAME 的告诫）。 */
export const CLOUD_VAULT_PATH = `/${CLOUD_VAULT_NAME}`;

/** 判定一份解析出来的 JSON 是否是形状完整的 vault。缺任何一项都视为损坏。 */
function isVaultFile(v: unknown): v is VaultFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === VAULT_VERSION &&
    typeof o.pwSalt === "string" &&
    typeof o.wrappedMkByPassword === "string" &&
    typeof o.wrappedMkByRecovery === "string" &&
    typeof o.mkCheck === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.kdf === "object" &&
    o.kdf !== null
  );
}

/** 上传（覆盖写）云端保险库。调用方负责在改密/恢复后重新调用，否则换机会拿到旧密文。 */
export async function putCloudVault(backend: Backend, vault: VaultFile): Promise<void> {
  await backend.putBlob(CLOUD_VAULT_PATH, Buffer.from(JSON.stringify(vault), "utf8"));
}

/**
 * 取回云端保险库；云端确实没有则返回 `null`。
 *
 * 「没有」与「坏了/取不到」必须严格区分，这条是承重的：换机流程用返回 `null` 判定
 * "这是个新用户"，进而 `bz init` 铸造一把全新 MK。若把损坏、网络失败、鉴权失败也
 * 一并退化成 `null`，老用户会在新机器上被误判为新用户，云端已有文件永久无法解密。
 * 因此：只有 `getBlob` 明确报告"不存在"才返回 `null`，其余一律抛错。
 */
export async function fetchCloudVault(backend: Backend): Promise<VaultFile | null> {
  const raw = await backend.getBlob(CLOUD_VAULT_PATH);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (cause) {
    throw new VaultError(
      "云端保险库无法解析（文件已损坏或被覆盖）。请勿在此状态下 `bz init`——那会生成新的主密钥，" +
        "使云端已有文件永久无法解密。请改用本机既有的保险库，或用恢复密钥找回。",
      { cause },
    );
  }
  if (!isVaultFile(parsed)) {
    throw new VaultError(
      "云端保险库格式不正确（字段残缺或版本不符）。请勿在此状态下 `bz init`——那会生成新的主密钥，" +
        "使云端已有文件永久无法解密。",
    );
  }
  return parsed;
}

/** 删除云端保险库；本就不存在时是幂等操作。 */
export async function removeCloudVault(backend: Backend): Promise<void> {
  await backend.removeBlob(CLOUD_VAULT_PATH);
}
