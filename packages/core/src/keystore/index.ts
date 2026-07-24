/**
 * SecretStore：本地机密（账号 token、解锁后的 MK 缓存）的读写抽象。
 *
 * 默认实现 FileSecretStore：用"设备密钥"（首次随机生成、0600 权限存本地）
 * 对整个机密文件做 AES-256-GCM 加密。这样 token 不以明文落盘，且与设备绑定
 * （随云同步泄露文件也无法解密）。OS 钥匙串后端（Keychain/Credential Manager）
 * 可实现同一接口在将来替换——接口不变，上层无感。
 *
 * 注意：设备密钥防的是"文件被顺走/误同步"，不防本机 root。真正的机密性来自
 * 主密码派生的 vault MK；token 本身即便泄露也只是访问用户自己的网盘。
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { openFromBase64, sealToBase64 } from "../crypto/index.ts";

export interface SecretStore {
  getAll(): Promise<Record<string, string>>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 内存实现，供测试。 */
export class MemorySecretStore implements SecretStore {
  private data: Record<string, string> = {};
  async getAll(): Promise<Record<string, string>> {
    return { ...this.data };
  }
  async get(key: string): Promise<string | undefined> {
    return this.data[key];
  }
  async set(key: string, value: string): Promise<void> {
    this.data[key] = value;
  }
  async delete(key: string): Promise<void> {
    delete this.data[key];
  }
}

/** 文件实现：设备密钥 AES-256-GCM 加密整个 KV JSON。 */
export class FileSecretStore implements SecretStore {
  constructor(
    private readonly dir: string,
    private readonly secretsPath: string,
    private readonly deviceKeyPath: string,
  ) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async deviceKey(): Promise<Buffer> {
    try {
      const b64 = await readFile(this.deviceKeyPath, "utf8");
      return Buffer.from(b64.trim(), "base64");
    } catch {
      await this.ensureDir();
      const key = randomBytes(32);
      await writeFile(this.deviceKeyPath, key.toString("base64"), { mode: 0o600 });
      await chmod(this.deviceKeyPath, 0o600).catch(() => {});
      return key;
    }
  }

  private async load(): Promise<Record<string, string>> {
    let enc: string;
    try {
      enc = await readFile(this.secretsPath, "utf8");
    } catch {
      return {};
    }
    const key = await this.deviceKey();
    const json = openFromBase64(key, enc.trim()).toString("utf8");
    return JSON.parse(json) as Record<string, string>;
  }

  private async save(data: Record<string, string>): Promise<void> {
    await this.ensureDir();
    const key = await this.deviceKey();
    const blob = sealToBase64(key, Buffer.from(JSON.stringify(data), "utf8"));
    await writeFile(this.secretsPath, blob, { mode: 0o600 });
    await chmod(this.secretsPath, 0o600).catch(() => {});
  }

  async getAll(): Promise<Record<string, string>> {
    return this.load();
  }
  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }
  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }
  async delete(key: string): Promise<void> {
    const data = await this.load();
    delete data[key];
    await this.save(data);
  }
}
