import { describe, expect, test } from "bun:test";
import { DEFAULT_SCRYPT, generateKey } from "../src/crypto/index.ts";
import { AuthError, VaultError } from "../src/errors.ts";
import {
  changePassword,
  createVault,
  unlockWithPassword,
  unlockWithRecovery,
  unwrapDek,
  wrapDek,
} from "../src/vault/index.ts";

const CREATED = "2026-07-23T00:00:00.000Z";
// 用低成本 KDF 参数加速测试（生产用 DEFAULT_SCRYPT）。
const FAST = { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 } as const;

async function newVault(pw = "correct horse battery staple") {
  return createVault(pw, { createdAt: CREATED, params: FAST });
}

describe("vault 解锁", () => {
  test("主密码解锁得到 MK，可解包资源 DEK", async () => {
    const { vault } = await newVault();
    const mk = await unlockWithPassword(vault, "correct horse battery staple");
    const dek = generateKey();
    const wrapped = wrapDek(mk, dek);
    expect(unwrapDek(mk, wrapped).equals(dek)).toBe(true);
  });

  test("恢复密钥解锁得到相同 MK", async () => {
    const { vault, recoveryKey } = await newVault();
    const mkPw = await unlockWithPassword(vault, "correct horse battery staple");
    const mkRk = await unlockWithRecovery(vault, recoveryKey);
    expect(mkRk.equals(mkPw)).toBe(true);
  });

  test("错误主密码 → AuthError", async () => {
    const { vault } = await newVault();
    await expect(unlockWithPassword(vault, "wrong")).rejects.toThrow(AuthError);
  });

  test("错误恢复密钥 → AuthError", async () => {
    const { vault } = await newVault();
    // 合法 base32、长度对，但内容错误
    const { recoveryKey: other } = await newVault();
    await expect(unlockWithRecovery(vault, other)).rejects.toThrow(AuthError);
  });

  test("恢复密钥长度不对 → AuthError", async () => {
    const { vault } = await newVault();
    await expect(unlockWithRecovery(vault, "AAAA-BBBB")).rejects.toThrow(AuthError);
  });

  test("空主密码 → VaultError", async () => {
    await expect(createVault("", { createdAt: CREATED, params: FAST })).rejects.toThrow(VaultError);
  });

  test("恢复密钥解锁对连字符/大小写宽容", async () => {
    const { vault, recoveryKey } = await newVault();
    const mangled = recoveryKey.replace(/-/g, "").toLowerCase();
    const mk = await unlockWithRecovery(vault, mangled);
    expect(mk.length).toBe(32);
  });
});

describe("改主密码", () => {
  test("改密后新密码可解、旧密码失效、恢复密钥仍有效、MK 不变", async () => {
    const { vault, recoveryKey } = await newVault("old-pass");
    const mkBefore = await unlockWithPassword(vault, "old-pass");

    const v2 = await changePassword(vault, "old-pass", "new-pass", FAST);

    const mkAfter = await unlockWithPassword(v2, "new-pass");
    expect(mkAfter.equals(mkBefore)).toBe(true); // MK 不变 → 老资源无需重新包裹
    await expect(unlockWithPassword(v2, "old-pass")).rejects.toThrow(AuthError);
    const mkRk = await unlockWithRecovery(v2, recoveryKey);
    expect(mkRk.equals(mkBefore)).toBe(true); // 恢复密钥仍有效
  });

  test("改密时当前密码错误 → AuthError", async () => {
    const { vault } = await newVault("old-pass");
    await expect(changePassword(vault, "bad", "new-pass", FAST)).rejects.toThrow(AuthError);
  });
});

describe("E-3 · scrypt 参数提升的向前兼容", () => {
  // v1.0.0 时代用 N=2^15 创建的 vault：DEFAULT_SCRYPT 提升后，老 vault 必须仍能用自己
  // 存的 kdf 参数解锁——unlockWithPassword 用 vault.kdf 派生，不能落回当前 DEFAULT_SCRYPT。
  const LEGACY_V1_0_0 = { algo: "scrypt", N: 1 << 15, r: 8, p: 1, keylen: 32 } as const;

  test("旧参数（N=2^15，v1.0.0 默认档）创建的 vault 仍能用主密码解锁", async () => {
    const { vault } = await createVault("legacy-pass", {
      createdAt: CREATED,
      params: LEGACY_V1_0_0,
    });
    expect(vault.kdf.N).toBe(1 << 15);
    const mk = await unlockWithPassword(vault, "legacy-pass");
    expect(mk.length).toBe(32);
  });

  test("新建 vault（不传 params）使用当前默认，kdf.N 为 2^17", async () => {
    const { vault } = await createVault("new-pass", { createdAt: CREATED });
    expect(vault.kdf.N).toBe(1 << 17);
    expect(vault.kdf.N).toBe(DEFAULT_SCRYPT.N);
    const mk = await unlockWithPassword(vault, "new-pass");
    expect(mk.length).toBe(32);
  });
});
