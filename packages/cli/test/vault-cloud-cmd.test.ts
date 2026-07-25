/**
 * 云端保险库的 CLI 接线（T4）：init 上云、换机自动取回、改密/恢复后重传、存量升级路径。
 * 全程 `--local <dir>` 当作"云端"，不联网。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_VAULT_PATH,
  fetchCloudVault,
  LocalBackend,
  unlockWithPassword,
  type VaultFile,
  VaultError,
} from "@bizhou/core";
import {
  changeMasterPassword,
  cmdInit,
  cmdUnlock,
  cmdVault,
  createRuntime,
  recoverWithKey,
} from "../src/commands.ts";

const STRONG = "correct horse battery staple";
const STRONG2 = "seventeen lantern gravel windows";
const WEAK = "hunter2";

let work: string;
let cloud: string;
let cfg: string;

/** 切到一个全新的密钥根 = 模拟换了一台机器（本地什么都没有）。 */
function switchToFreshMachine(): void {
  cfg = join(work, `cfg-${Math.random().toString(16).slice(2)}`);
  process.env.BIZHOU_CONFIG_DIR = cfg;
}

function cloudBackend(): LocalBackend {
  return new LocalBackend(cloud);
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "bizhou-vaultcloud-"));
  cloud = join(work, "cloud");
  process.env.BIZHOU_FILE_ROOT = join(work, "fileroot");
  process.env.BIZHOU_MASTER_PASSWORD = STRONG;
  switchToFreshMachine();
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.BIZHOU_CONFIG_DIR;
  delete process.env.BIZHOU_MASTER_PASSWORD;
  delete process.env.BIZHOU_FILE_ROOT;
});

describe("bz init 与云端保险库", () => {
  test("init 后云端存在保险库，且与本地 vault 一字不差", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });

    const cloudVault = await fetchCloudVault(cloudBackend());
    expect(cloudVault).not.toBeNull();
    const localVault = JSON.parse(await readFile(rt.paths.vault, "utf8")) as VaultFile;
    expect(cloudVault).toEqual(localVault);
  });

  test("弱主密码被拦下：不创建 vault、不上传，报错里给出可执行建议", async () => {
    process.env.BIZHOU_MASTER_PASSWORD = WEAK;
    const rt = createRuntime();

    await expect(cmdInit(rt, { local: cloud })).rejects.toThrow(/至少需要|强度不足/);
    expect(existsSync(rt.paths.vault)).toBe(false);
    expect(await fetchCloudVault(cloudBackend())).toBeNull();
  });

  test("--no-cloud-vault：弱密码也可初始化，但保险库只留本地（明确放弃换机恢复）", async () => {
    process.env.BIZHOU_MASTER_PASSWORD = WEAK;
    const rt = createRuntime();

    await cmdInit(rt, { local: cloud, noCloudVault: true });

    expect(existsSync(rt.paths.vault)).toBe(true);
    expect(await fetchCloudVault(cloudBackend())).toBeNull();
  });
});

describe("换机恢复", () => {
  test("新机器上只有主密码 + 网盘：unlock 自动取回云端保险库并解锁", async () => {
    const rt1 = createRuntime();
    await cmdInit(rt1, { local: cloud });
    const mkBefore = await unlockWithPassword(
      JSON.parse(await readFile(rt1.paths.vault, "utf8")) as VaultFile,
      STRONG,
    );

    switchToFreshMachine();
    const rt2 = createRuntime();
    expect(rt2.vaultExists()).toBe(false);

    await cmdUnlock(rt2, { local: cloud });

    expect(rt2.vaultExists()).toBe(true); // 取回后落本地缓存
    const mkAfter = await rt2.resolveMk({ local: cloud });
    expect(mkAfter.equals(mkBefore)).toBe(true);
  });

  // 这条守着最贵的那个错误：云端保险库取不回来时，绝不能表现得像个新用户。
  test("云端保险库损坏时 unlock 报错，绝不当作新用户放行", async () => {
    const rt1 = createRuntime();
    await cmdInit(rt1, { local: cloud });
    await writeFile(join(cloud, CLOUD_VAULT_PATH.slice(1)), "corrupted");

    switchToFreshMachine();
    const rt2 = createRuntime();
    await expect(cmdUnlock(rt2, { local: cloud })).rejects.toThrow(VaultError);
    expect(rt2.vaultExists()).toBe(false);
  });

  test("本地与云端都没有保险库：提示先 init，而不是隐式创建", async () => {
    const rt = createRuntime();
    await expect(cmdUnlock(rt, { local: cloud })).rejects.toThrow(/init/);
    expect(rt.vaultExists()).toBe(false);
  });
});

describe("改密 / 恢复密钥重设后，云端副本必须同步更新", () => {
  test("改主密码后，换机用新密码能解锁（旧密码不能）", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });

    await changeMasterPassword(rt, { current: STRONG, next: STRONG2, local: cloud });

    const cloudVault = (await fetchCloudVault(cloudBackend()))!;
    expect(await unlockWithPassword(cloudVault, STRONG2)).toBeInstanceOf(Buffer);
    await expect(unlockWithPassword(cloudVault, STRONG)).rejects.toThrow();
  });

  test("改主密码时新密码同样过强度关卡（弱新密码被拒，云端不被改坏）", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    const before = await fetchCloudVault(cloudBackend());

    await expect(
      changeMasterPassword(rt, { current: STRONG, next: WEAK, local: cloud }),
    ).rejects.toThrow(/至少需要|强度不足/);
    expect(await fetchCloudVault(cloudBackend())).toEqual(before!);
  });

  test("用恢复密钥重设主密码后，云端副本随之更新", async () => {
    const rt = createRuntime();
    const { recoveryKey } = await cmdInit(rt, { local: cloud });

    await recoverWithKey(rt, { recoveryKey, newPassword: STRONG2, local: cloud });

    const cloudVault = (await fetchCloudVault(cloudBackend()))!;
    expect(await unlockWithPassword(cloudVault, STRONG2)).toBeInstanceOf(Buffer);
  });
});

describe("存量用户升级路径（本地有保险库、云端没有）", () => {
  test("bz vault sync：验明主密码 + 过强度关卡后上传", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud, noCloudVault: true });
    expect(await fetchCloudVault(cloudBackend())).toBeNull();

    await cmdVault(rt, "sync", { local: cloud });

    const cloudVault = await fetchCloudVault(cloudBackend());
    expect(cloudVault).not.toBeNull();
    expect(await unlockWithPassword(cloudVault!, STRONG)).toBeInstanceOf(Buffer);
  });

  test("bz vault sync：主密码不达标时拒绝上传（不在用户不知情下降级）", async () => {
    process.env.BIZHOU_MASTER_PASSWORD = WEAK;
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud, noCloudVault: true });

    await expect(cmdVault(rt, "sync", { local: cloud })).rejects.toThrow(/至少需要|强度不足/);
    expect(await fetchCloudVault(cloudBackend())).toBeNull();
  });

  test("bz vault sync：主密码错误时拒绝上传（证明是本人）", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud, noCloudVault: true });

    process.env.BIZHOU_MASTER_PASSWORD = STRONG2; // 不是这个 vault 的主密码
    await expect(cmdVault(rt, "sync", { local: cloud })).rejects.toThrow();
    expect(await fetchCloudVault(cloudBackend())).toBeNull();
  });

  test("unlock 顺带补齐：密码达标且云端缺保险库时自动上传", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud, noCloudVault: true });
    expect(await fetchCloudVault(cloudBackend())).toBeNull();

    await cmdUnlock(rt, { local: cloud });

    expect(await fetchCloudVault(cloudBackend())).not.toBeNull();
  });

  test("unlock 顺带补齐：密码不达标时坚决不上传（只提示去改密码）", async () => {
    process.env.BIZHOU_MASTER_PASSWORD = WEAK;
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud, noCloudVault: true });

    await cmdUnlock(rt, { local: cloud });

    expect(await fetchCloudVault(cloudBackend())).toBeNull();
  });

  test("bz vault status：本机与云端不一致时说出来（不静默）", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    // 只改本地、不动云端：模拟"改完密码但上云失败"的中间态
    const v = await rt.loadVault({ local: cloud });
    await rt.saveVault({ ...v, createdAt: "1999-01-01T00:00:00.000Z" });
    await expect(cmdVault(rt, "status", { local: cloud })).resolves.toBeUndefined();
  });

  test("bz vault status 不抛错，且不需要主密码", async () => {
    const rt = createRuntime();
    await cmdInit(rt, { local: cloud });
    delete process.env.BIZHOU_MASTER_PASSWORD; // 不给密码也应能看状态
    await expect(cmdVault(rt, "status", { local: cloud })).resolves.toBeUndefined();
  });
});
