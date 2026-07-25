import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../src/backend/local.ts";
import { VaultError } from "../src/errors.ts";
import {
  CLOUD_VAULT_PATH,
  createVault,
  fetchCloudVault,
  putCloudVault,
  removeCloudVault,
  unlockWithPassword,
} from "../src/vault/index.ts";

const CREATED = "2026-07-25T00:00:00.000Z";
// 低成本 KDF 参数加速测试（生产用 DEFAULT_SCRYPT）。
const FAST = { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keylen: 32 } as const;
const PW = "correct horse battery staple";

async function withBackend<T>(fn: (be: LocalBackend, base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "bizhou-cloudvault-"));
  try {
    return await fn(new LocalBackend(base), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe("云端保险库", () => {
  test("putCloudVault → fetchCloudVault 往返得到等价 VaultFile", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      await putCloudVault(be, vault);
      expect(await fetchCloudVault(be)).toEqual(vault);
    });
  });

  test("换机语义：只凭云端取回的 vault + 主密码即可解出同一 MK", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      const mkHere = await unlockWithPassword(vault, PW);
      await putCloudVault(be, vault);

      // 新机器：本地什么都没有，只有网盘账号与主密码
      const fetched = await fetchCloudVault(be);
      expect(fetched).not.toBeNull();
      const mkThere = await unlockWithPassword(fetched!, PW);
      expect(mkThere.equals(mkHere)).toBe(true);
    });
  });

  test("云端没有保险库时 fetchCloudVault 返回 null", async () => {
    await withBackend(async (be) => {
      expect(await fetchCloudVault(be)).toBeNull();
    });
  });

  // 这条是承重的：损坏必须抛错。若退化成返回 null，换机流程会把老用户误判为
  // 新用户 → bz init 铸造全新 MK → 云端已有文件永久无法解密（不可逆数据丢失）。
  test("云端保险库损坏（非 JSON）必须抛 VaultError，绝不返回 null", async () => {
    await withBackend(async (be) => {
      await be.putBlob(CLOUD_VAULT_PATH, Buffer.from("not json at all"));
      await expect(fetchCloudVault(be)).rejects.toThrow(VaultError);
    });
  });

  test("云端保险库字段残缺（如缺 wrappedMkByPassword）必须抛 VaultError", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      const broken = { ...vault, wrappedMkByPassword: undefined };
      await be.putBlob(CLOUD_VAULT_PATH, Buffer.from(JSON.stringify(broken), "utf8"));
      await expect(fetchCloudVault(be)).rejects.toThrow(VaultError);
    });
  });

  test("removeCloudVault 之后 fetchCloudVault 回到 null（且对本就没有是幂等的）", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      await putCloudVault(be, vault);
      await removeCloudVault(be);
      expect(await fetchCloudVault(be)).toBeNull();
      await expect(removeCloudVault(be)).resolves.toBeUndefined();
    });
  });

  test("保险库不出现在 listDir 里（bz ls 看不到它）", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      await putCloudVault(be, vault);
      await be.mkdir("/工作");
      const listing = await be.listDir("/");
      expect(listing.dirs).toEqual(["工作"]);
      expect(listing.bundles).toEqual([]);
    });
  });

  // 保险库名是保留名：即便云端出现同名的**目录**（历史残留、手工误建），
  // 也不能作为用户目录列出来——否则 bz ls 会冒出一个用户不认识、进去还是空的条目。
  test("与保险库同名的目录同样被 listDir 过滤掉", async () => {
    await withBackend(async (be, base) => {
      await mkdir(join(base, CLOUD_VAULT_PATH.slice(1)), { recursive: true });
      expect((await be.listDir("/")).dirs).toEqual([]);
    });
  });

  test("云端保险库路径不含产品名等显眼指纹（E-4 不透明命名）", () => {
    expect(CLOUD_VAULT_PATH.toLowerCase()).not.toContain("vault");
    expect(CLOUD_VAULT_PATH.toLowerCase()).not.toContain("bizhou");
    expect(CLOUD_VAULT_PATH.toLowerCase()).not.toContain("key");
  });

  test("putCloudVault 覆盖写：第二次上传后取回的是新内容", async () => {
    await withBackend(async (be) => {
      const { vault: v1 } = await createVault(PW, { createdAt: CREATED, params: FAST });
      const { vault: v2 } = await createVault("another password", {
        createdAt: "2026-07-26T00:00:00.000Z",
        params: FAST,
      });
      await putCloudVault(be, v1);
      await putCloudVault(be, v2);
      expect(await fetchCloudVault(be)).toEqual(v2);
    });
  });

  test("云端保险库是 vault 原样的 JSON（本身已是密文信封），且不含任何明文密钥材料", async () => {
    await withBackend(async (be) => {
      const { vault } = await createVault(PW, { createdAt: CREATED, params: FAST });
      await putCloudVault(be, vault);
      const raw = (await be.getBlob(CLOUD_VAULT_PATH))!.toString("utf8");
      expect(JSON.parse(raw)).toEqual(vault);
      expect(raw).not.toContain(PW);
    });
  });
});
