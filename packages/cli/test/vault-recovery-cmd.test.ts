/**
 * `bz vault recovery-key`（E-5）：重新导出同一串恢复密钥；老 vault 走 --rotate。
 * 入口必须强制重输主密码——已解锁的会话不算数。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCloudVault,
  hasExportableRecoveryKey,
  LocalBackend,
  unlockWithPassword,
  unlockWithRecovery,
  type VaultFile,
} from "@bizhou/core";
import { cmdInit, cmdUnlock, cmdVault, createRuntime } from "../src/commands.ts";

const STRONG = "correct horse battery staple";

let work: string;
let cloud: string;

/** 捕获 stdout（`out()` 走 stdout，恢复密钥就打在这里）。 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return buf;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "bizhou-recovery-"));
  cloud = join(work, "cloud");
  process.env.BIZHOU_CONFIG_DIR = join(work, "cfg");
  process.env.BIZHOU_FILE_ROOT = join(work, "fileroot");
  process.env.BIZHOU_MASTER_PASSWORD = STRONG;
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.BIZHOU_CONFIG_DIR;
  delete process.env.BIZHOU_MASTER_PASSWORD;
  delete process.env.BIZHOU_FILE_ROOT;
});

describe("bz vault recovery-key", () => {
  test("重新导出的就是 init 时那一串恢复密钥", async () => {
    const rt = createRuntime();
    const { recoveryKey } = await cmdInit(rt, { local: cloud });

    const printed = await captureStdout(() => cmdVault(rt, "recovery-key", { local: cloud }));

    expect(printed).toContain(recoveryKey);
  });

  // 这是 E-5 的安全条件：允许重导出，意味着"已解锁会话"若能直接取走恢复密钥，
  // 攻击者就拿到了一张改主密码也撤销不掉的长期通行证。所以必须重输主密码。
  test("主密码不对时拒绝导出（即使本设备会话已解锁）", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    await cmdUnlock(rt, { local: cloud }); // 会话已解锁，MK 已缓存

    process.env.BIZHOU_MASTER_PASSWORD = "wrong password entirely";
    await expect(cmdVault(rt, "recovery-key", { local: cloud })).rejects.toThrow();
  });

  test("v1.0.x 老 vault：直接导出被拒，并指出 --rotate 这条路", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    const v = (await rt.loadVault({ local: cloud })) as VaultFile & { wrappedRecoveryByMk?: string };
    const { wrappedRecoveryByMk: _drop, ...legacy } = v;
    await rt.saveVault(legacy as VaultFile);

    await expect(cmdVault(rt, "recovery-key", { local: cloud })).rejects.toThrow(/rotate/);
  });

  test("--rotate：老 vault 换出新恢复密钥，旧的作废，本地与云端一起更新", async () => {
    const rt = createRuntime();
    const { recoveryKey: oldKey } = await cmdInit(rt, { local: cloud });
    const v = (await rt.loadVault({ local: cloud })) as VaultFile & { wrappedRecoveryByMk?: string };
    const { wrappedRecoveryByMk: _drop, ...legacy } = v;
    await rt.saveVault(legacy as VaultFile);

    const printed = await captureStdout(() =>
      cmdVault(rt, "recovery-key", { local: cloud, rotate: true }),
    );
    const newKey = printed.trim().split("\n").pop()!.trim();

    expect(newKey).not.toBe(oldKey);
    const local = await rt.loadVault({ local: cloud });
    expect(hasExportableRecoveryKey(local)).toBe(true);
    const mk = await unlockWithPassword(local, STRONG);
    expect((await unlockWithRecovery(local, newKey)).equals(mk)).toBe(true);
    await expect(unlockWithRecovery(local, oldKey)).rejects.toThrow();

    // 云端副本必须跟着换，否则换机取回的 vault 只认已作废的旧恢复密钥
    const cloudVault = (await fetchCloudVault(new LocalBackend(cloud)))!;
    expect(cloudVault).toEqual(local);
  });

  test("--rotate 遇到主密码错误时不改动任何东西", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    const before = await rt.loadVault({ local: cloud });

    process.env.BIZHOU_MASTER_PASSWORD = "wrong password entirely";
    await expect(
      cmdVault(rt, "recovery-key", { local: cloud, rotate: true }),
    ).rejects.toThrow();

    expect(await rt.loadVault({ local: cloud })).toEqual(before);
  });
});
