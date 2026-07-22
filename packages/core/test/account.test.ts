import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/account/index.ts";
import { configPaths, resolveConfigDir } from "../src/config/index.ts";
import { FileSecretStore, MemorySecretStore } from "../src/keystore/index.ts";

describe("config 目录解析", () => {
  test("BIZHOU_CONFIG_DIR 优先", () => {
    expect(resolveConfigDir({ BIZHOU_CONFIG_DIR: "/x/y" }, "linux")).toBe("/x/y");
  });
  test("各平台默认路径", () => {
    expect(resolveConfigDir({ HOME: "/home/u" }, "darwin")).toBe(
      "/home/u/Library/Application Support/bizhou",
    );
    expect(resolveConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toContain(
      "bizhou",
    );
    expect(resolveConfigDir({ HOME: "/home/u" }, "linux")).toBe("/home/u/.config/bizhou");
    expect(resolveConfigDir({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(
      "/cfg/bizhou",
    );
  });
});

describe("AccountManager（内存 store）", () => {
  test("首个账号自动设为当前；增删改查", async () => {
    const am = new AccountManager(new MemorySecretStore());
    await am.upsertAccount("alice", { accessToken: "AT1" });
    let list = await am.listAccounts();
    expect(list.names).toEqual(["alice"]);
    expect(list.current).toBe("alice");

    await am.upsertAccount("bob", { accessToken: "AT2" });
    await am.useAccount("bob");
    expect((await am.getCurrent())?.name).toBe("bob");

    await am.updateTokens("bob", { accessToken: "AT2b", refreshToken: "RT" });
    expect((await am.getCurrent())?.tokens.accessToken).toBe("AT2b");

    await am.removeAccount("bob");
    list = await am.listAccounts();
    expect(list.names).toEqual(["alice"]);
    expect(list.current).toBe("alice"); // 删当前后回退到剩余账号
  });

  test("MK 缓存：过期后清除", async () => {
    const am = new AccountManager(new MemorySecretStore());
    const mk = Buffer.alloc(32, 7);
    await am.cacheMk(mk, 1000);
    expect((await am.getCachedMk(500))?.equals(mk)).toBe(true); // 未过期
    expect(await am.getCachedMk(2000)).toBeUndefined(); // 已过期
    expect(await am.getCachedMk(500)).toBeUndefined(); // 过期后已被清除
  });
});

describe("FileSecretStore（设备密钥加密落盘）", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bizhou-sec-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("加密落盘、重新打开可读、密文不含明文 token", async () => {
    const p = configPaths({ BIZHOU_CONFIG_DIR: dir }, "linux");
    const store1 = new FileSecretStore(p.dir, p.secrets, p.deviceKey);
    const am1 = new AccountManager(store1);
    await am1.upsertAccount("alice", { accessToken: "SUPER_SECRET_TOKEN" });

    // 磁盘上的密文不含明文
    const onDisk = await readFile(p.secrets, "utf8");
    expect(onDisk).not.toContain("SUPER_SECRET_TOKEN");
    expect(onDisk).not.toContain("alice");

    // 新实例（读回设备密钥）能解开
    const store2 = new FileSecretStore(p.dir, p.secrets, p.deviceKey);
    const am2 = new AccountManager(store2);
    expect((await am2.getCurrent())?.tokens.accessToken).toBe("SUPER_SECRET_TOKEN");
  });
});
