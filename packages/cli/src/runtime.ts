/**
 * CLI 运行时装配：加载 .env、解析配置目录、构建 SecretStore/AccountManager、
 * 提供 HTTP 适配、vault 读写与 MK 解析。把"读时钟/读进程/读文件"等副作用收敛在此，
 * 核心库保持纯净。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AccountManager,
  type Backend,
  BaiduBackend,
  BaiduClient,
  type ConfigPaths,
  configPaths,
  FileSecretStore,
  type HttpClient,
  LocalBackend,
  type OAuthConfig,
  refreshAccessToken,
  resolveFileRoot,
  unlockWithPassword,
  VaultError,
  type VaultFile,
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
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
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
  readonly fileRoot: string;
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

  // 读 config.json 里的 fileRoot（若有）
  let configFileRoot: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(paths.config, "utf8")) as { fileRoot?: string };
    configFileRoot = cfg.fileRoot;
  } catch {
    /* 无 config.json，忽略 */
  }
  const fileRoot = resolveFileRoot(process.env, process.platform, configFileRoot);

  return {
    paths,
    accounts,
    http: httpAdapter,
    fileRoot,
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

/** 为当前账号构建 Baidu 客户端（token 临近过期时用 refresh_token 自动刷新）。 */
export async function baiduClientForCurrent(rt: Runtime): Promise<BaiduClient> {
  const cur = await rt.accounts.getCurrent();
  if (!cur) {
    throw new VaultError("尚未登录任何账号：请先 `bz login`");
  }
  let tokens = cur.tokens;
  const nearExpiry = tokens.expiresAt !== undefined && Date.now() > tokens.expiresAt - 60_000;
  if (nearExpiry && tokens.refreshToken) {
    const r = await refreshAccessToken(rt.oauthConfig(), tokens.refreshToken, rt.http);
    tokens = {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + r.expiresIn * 1000,
      scope: r.scope ?? tokens.scope,
    };
    await rt.accounts.updateTokens(cur.name, tokens);
  }
  return new BaiduClient(rt.oauthConfig(), tokens.accessToken, rt.http);
}

/** 按 --local 选后端：本地目录 or 百度。 */
export async function makeBackend(rt: Runtime, localDir: string | undefined): Promise<Backend> {
  if (localDir) return new LocalBackend(localDir);
  return new BaiduBackend(await baiduClientForCurrent(rt));
}
