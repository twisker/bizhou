import { describe, expect, test } from "bun:test";
import { VaultError } from "../src/errors.ts";
import {
  changePassword,
  createVault,
  exportRecoveryKey,
  hasExportableRecoveryKey,
  rotateRecoveryKey,
  unlockWithPassword,
  unlockWithRecovery,
  type VaultFile,
} from "../src/vault/index.ts";

const CREATED = "2026-07-25T00:00:00.000Z";
const FAST = { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 } as const;
const PW = "correct horse battery staple";
const PW2 = "seventeen lantern gravel windows";

async function newVault() {
  return createVault(PW, { createdAt: CREATED, params: FAST });
}

/** v1.0.x 的 vault：没有 wrappedRecoveryByMk 字段。 */
function asLegacy(vault: VaultFile): VaultFile {
  const { wrappedRecoveryByMk: _drop, ...rest } = vault as VaultFile & {
    wrappedRecoveryByMk?: string;
  };
  return rest as VaultFile;
}

describe("恢复密钥重导出（E-5）", () => {
  test("新建的 vault 可以重新导出**同一串**恢复密钥", async () => {
    const { vault, recoveryKey } = await newVault();
    const mk = await unlockWithPassword(vault, PW);
    expect(exportRecoveryKey(vault, mk)).toBe(recoveryKey);
  });

  test("重导出的密钥确实能解锁（不只是长得一样）", async () => {
    const { vault } = await newVault();
    const mk = await unlockWithPassword(vault, PW);
    const again = exportRecoveryKey(vault, mk);
    expect((await unlockWithRecovery(vault, again)).equals(mk)).toBe(true);
  });

  test("改主密码后仍能导出同一串恢复密钥（恢复密钥与主密码无关）", async () => {
    const { vault, recoveryKey } = await newVault();
    const v2 = await changePassword(vault, PW, PW2, FAST);
    const mk = await unlockWithPassword(v2, PW2);
    expect(exportRecoveryKey(v2, mk)).toBe(recoveryKey);
  });

  test("MK 不对时导出失败，绝不吐出垃圾字符串", async () => {
    const { vault } = await newVault();
    const { vault: other } = await createVault(PW2, { createdAt: CREATED, params: FAST });
    const wrongMk = await unlockWithPassword(other, PW2);
    expect(() => exportRecoveryKey(vault, wrongMk)).toThrow(VaultError);
  });

  test("v1.0.x 老 vault 没有这份包裹：hasExportableRecoveryKey 为 false，导出抛错", async () => {
    const { vault } = await newVault();
    const legacy = asLegacy(vault);
    expect(hasExportableRecoveryKey(legacy)).toBe(false);
    const mk = await unlockWithPassword(legacy, PW);
    expect(() => exportRecoveryKey(legacy, mk)).toThrow(VaultError);
  });

  test("老 vault 可以轮换出新恢复密钥：新的能解锁、旧的立即作废、MK 不变", async () => {
    const { vault, recoveryKey: oldKey } = await newVault();
    const legacy = asLegacy(vault);
    const mk = await unlockWithPassword(legacy, PW);

    const { vault: rotated, recoveryKey: newKey } = rotateRecoveryKey(legacy, mk);

    expect(newKey).not.toBe(oldKey);
    expect((await unlockWithRecovery(rotated, newKey)).equals(mk)).toBe(true);
    await expect(unlockWithRecovery(rotated, oldKey)).rejects.toThrow();
    expect((await unlockWithPassword(rotated, PW)).equals(mk)).toBe(true); // 主密码不受影响
  });

  test("轮换后这份 vault 也变成可重导出的", async () => {
    const { vault } = await newVault();
    const mk = await unlockWithPassword(vault, PW);
    const { vault: rotated, recoveryKey } = rotateRecoveryKey(asLegacy(vault), mk);
    expect(hasExportableRecoveryKey(rotated)).toBe(true);
    expect(exportRecoveryKey(rotated, mk)).toBe(recoveryKey);
  });

  // 轮换会重写 wrappedMkByRecovery。若拿错 MK 也照写不误，就等于用一把错钥匙覆盖了
  // 唯一的备用入口——旧恢复密钥作废、新恢复密钥解出的又是错 MK，数据从此取不回来。
  test("MK 不对时拒绝轮换，绝不用错钥匙覆盖备用入口", async () => {
    const { vault } = await newVault();
    const { vault: other } = await createVault(PW2, { createdAt: CREATED, params: FAST });
    const wrongMk = await unlockWithPassword(other, PW2);
    expect(() => rotateRecoveryKey(vault, wrongMk)).toThrow(VaultError);
  });

  test("vault 里存的是密文：恢复密钥本身不以明文出现在文件里", async () => {
    const { vault, recoveryKey } = await newVault();
    const raw = JSON.stringify(vault);
    expect(raw).not.toContain(recoveryKey);
    expect(raw).not.toContain(recoveryKey.replace(/-/g, ""));
  });
});
