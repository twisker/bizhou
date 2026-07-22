/**
 * CLI 运行时装配：加载 .env、解析配置目录、构建 SecretStore/AccountManager、
 * 提供 HTTP 适配、vault 读写与 MK 解析。把"读时钟/读进程/读文件"等副作用收敛在此，
 * 核心库保持纯净。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccountManager,
  type BundleStore,
  BaiduBundleStore,
  BaiduClient,
  configPaths,
  type ConfigPaths,
  type HttpClient,
  type OAuthConfig,
  FileSecretStore,
  LocalBundleStore,
  unlockWithPassword,
  type VaultFile,
  VaultError,
} from "@bizhou/core";
import { resolveMasterPassword } from "./prompt.ts";

/** 极简 .env 解析（无依赖）：KEY=value / KEY='value' / KEY="value"，# 注释与空行忽略。 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** 从 cwd/.env 载入（不覆盖已存在的 process.env）。 */
export function loadDotenv(cwd = process.cwd()): void {
  const p = join(cwd, ".env");
  if (!existsSync(p)) return;
  const parsed = parseDotenv(readFileSync(p, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export interface Runtime {
  readonly paths: ConfigPaths;
  readonly accounts: AccountManager;
  readonly http: HttpClient;
  now(): number;
  oauthConfig(): OAuthConfig;
  loadVault(): Promise<VaultFile>;
  vaultExists(): boolean;
  saveVault(v: VaultFile): Promise<void>;
  /** 解析 MK：优先用已缓存（bz unlock 后），否则提示主密码并临时解锁。 */
  resolveMk(opts?: { passwordStdin?: boolean }): Promise<Buffer>;
}

const httpAdapter: HttpClient = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<HttpClient>;

export function createRuntime(): Runtime {
  loadDotenv();
  const paths = configPaths(process.env, process.platform);
  const secrets = new FileSecretStore(paths.dir, paths.secrets, paths.deviceKey);
  const accounts = new AccountManager(secrets);

  return {
    paths,
    accounts,
    http: httpAdapter,
    now: () => Date.now(),
    oauthConfig(): OAuthConfig {
      const appKey = process.env.BAIDU_APP_KEY;
      const secretKey = process.env.BAIDU_SECRET_KEY;
      if (!appKey || !secretKey) {
        throw new VaultError(
          "缺少百度凭证：请在 .env 配置 BAIDU_APP_KEY 与 BAIDU_SECRET_KEY（见 .env.example）",
        );
      }
      return { appKey, secretKey };
    },
    vaultExists: () => existsSync(paths.vault),
    async loadVault(): Promise<VaultFile> {
      if (!existsSync(paths.vault)) {
        throw new VaultError("尚未初始化：请先运行 `bz init`");
      }
      return JSON.parse(await readFile(paths.vault, "utf8")) as VaultFile;
    },
    async saveVault(v: VaultFile): Promise<void> {
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.vault, JSON.stringify(v, null, 2), "utf8");
    },
    async resolveMk(opts = {}): Promise<Buffer> {
      const cached = await accounts.getCachedMk(Date.now());
      if (cached) return cached;
      const vault = await this.loadVault();
      const pw = await resolveMasterPassword("主密码: ", opts);
      return unlockWithPassword(vault, pw);
    },
  };
}

/** 为当前账号构建 Baidu 客户端（自动刷新过期 token）。 */
export async function baiduClientForCurrent(rt: Runtime): Promise<BaiduClient> {
  const cur = await rt.accounts.getCurrent();
  if (!cur) {
    throw new VaultError("尚未登录任何账号：请先 `bz login`");
  }
  return new BaiduClient(rt.oauthConfig(), cur.tokens.accessToken, rt.http);
}

/** 根据 --local 选项决定用本地目录 store 还是百度 store。 */
export async function makeStore(
  rt: Runtime,
  bundleId: string,
  localDir: string | undefined,
): Promise<BundleStore> {
  if (localDir) return new LocalBundleStore(localDir, bundleId);
  return new BaiduBundleStore(await baiduClientForCurrent(rt), bundleId);
}
