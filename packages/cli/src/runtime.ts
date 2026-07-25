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
  fetchCloudVault,
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
import { info } from "./render.ts";

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
  /** 分片上传默认并发度（config.json `uploadConcurrency` 覆盖，clamp[1,16]，缺省 4）。 */
  readonly uploadConcurrency: number;
  /** daemon 定时兜底 sweep 间隔 ms（config.json `daemonSweepIntervalMs` 覆盖，min 5s，缺省 30min）。 */
  readonly daemonSweepIntervalMs: number;
  /** daemon watcher 防抖 ms（config.json `daemonDebounceMs` 覆盖，min 100ms，缺省 2s）。 */
  readonly daemonDebounceMs: number;
  now(): number;
  oauthConfig(): OAuthConfig;
  /**
   * 读保险库：本地优先；本地没有则去云端取（换机恢复）。
   * `local` 指定后端目录（`--local`）；不给则用当前账号的网盘，未登录时不查云端。
   */
  loadVault(opts?: { local?: string }): Promise<VaultFile>;
  vaultExists(): boolean;
  saveVault(v: VaultFile): Promise<void>;
  /** 解析 MK：优先用已缓存（bz unlock 后），否则提示主密码并临时解锁。 */
  resolveMk(opts?: { passwordStdin?: boolean; local?: string }): Promise<Buffer>;
}

const httpAdapter: HttpClient = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<HttpClient>;

export function createRuntime(): Runtime {
  loadDotenv();
  const paths = configPaths(process.env, process.platform);
  const secrets = new FileSecretStore(paths.dir, paths.secrets, paths.deviceKey);
  const accounts = new AccountManager(secrets);

  // 读 config.json 里的 fileRoot / uploadConcurrency / daemonSweepIntervalMs / daemonDebounceMs（若有）
  let configFileRoot: string | undefined;
  let configUploadConcurrency: number | undefined;
  let configDaemonSweepIntervalMs: number | undefined;
  let configDaemonDebounceMs: number | undefined;
  try {
    const cfg = JSON.parse(readFileSync(paths.config, "utf8")) as {
      fileRoot?: string;
      uploadConcurrency?: number;
      daemonSweepIntervalMs?: number;
      daemonDebounceMs?: number;
    };
    configFileRoot = cfg.fileRoot;
    configUploadConcurrency = cfg.uploadConcurrency;
    configDaemonSweepIntervalMs = cfg.daemonSweepIntervalMs;
    configDaemonDebounceMs = cfg.daemonDebounceMs;
  } catch {
    /* 无 config.json，忽略 */
  }
  const fileRoot = resolveFileRoot(process.env, process.platform, configFileRoot);
  const uploadConcurrency = Math.min(16, Math.max(1, configUploadConcurrency ?? 4));
  const daemonSweepIntervalMs = Math.max(5_000, configDaemonSweepIntervalMs ?? 30 * 60 * 1000);
  const daemonDebounceMs = Math.max(100, configDaemonDebounceMs ?? 2_000);

  return {
    paths,
    accounts,
    http: httpAdapter,
    fileRoot,
    uploadConcurrency,
    daemonSweepIntervalMs,
    daemonDebounceMs,
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
    async loadVault(opts: { local?: string } = {}): Promise<VaultFile> {
      if (existsSync(paths.vault)) {
        return JSON.parse(await readFile(paths.vault, "utf8")) as VaultFile;
      }
      // 本地没有 —— 很可能是换了新机器。v1.1.0 起 init 会把保险库加密上云，去取回来。
      // fetchCloudVault 只在"云端确实没有"时返回 null；损坏或取不到都会抛错，
      // 绝不会退化成"当作新用户"（那会让 bz init 铸造新 MK，锁死云端已有数据）。
      const backend = await backendIfPossible(this, opts.local);
      const cloud = backend ? await fetchCloudVault(backend) : null;
      if (cloud) {
        await this.saveVault(cloud);
        info(`已从云端取回保险库 → ${paths.vault}`);
        return cloud;
      }
      throw new VaultError(
        backend
          ? "尚未初始化：请先运行 `bz init`"
          : "尚未初始化：请先运行 `bz init`；若这是换机恢复，请先 `bz login` 登录网盘后重试",
      );
    },
    async saveVault(v: VaultFile): Promise<void> {
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.vault, JSON.stringify(v, null, 2), "utf8");
    },
    async resolveMk(opts: { passwordStdin?: boolean; local?: string } = {}): Promise<Buffer> {
      const cached = await accounts.getCachedMk(Date.now());
      if (cached) return cached;
      const vault = await this.loadVault({ local: opts.local });
      const pw = await resolveMasterPassword("主密码: ", opts);
      return unlockWithPassword(vault, pw);
    },
  };
}

/** 为当前账号构建 Baidu 客户端（token 临近过期时用 refresh_token 自动刷新）。
 * `concurrency` 覆盖分片上传并发度；缺省用 `rt.uploadConcurrency`。 */
export async function baiduClientForCurrent(
  rt: Runtime,
  concurrency?: number,
): Promise<BaiduClient> {
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
  return new BaiduClient(rt.oauthConfig(), tokens.accessToken, rt.http, {
    uploadConcurrency: concurrency ?? rt.uploadConcurrency,
  });
}

/**
 * 与 `makeBackend` 相同，但"没有可用后端"是一个正常返回值而非异常：
 * 未登录且未给 `--local` 时返回 `null`，供云端保险库这类"能同步就同步"的路径判断。
 *
 * 只有"没有账号"这一种情况会转成 `null`；token 刷新失败、凭证缺失等真实故障照常抛出，
 * 不能让它们伪装成"这台机器还没登录"。
 */
export async function backendIfPossible(
  rt: Runtime,
  localDir: string | undefined,
): Promise<Backend | null> {
  if (!localDir && !(await rt.accounts.getCurrent())) return null;
  return makeBackend(rt, localDir);
}

/** 按 --local 选后端：本地目录 or 百度。`concurrency` 透传给百度分片上传并发度。 */
export async function makeBackend(
  rt: Runtime,
  localDir: string | undefined,
  concurrency?: number,
): Promise<Backend> {
  if (localDir) return new LocalBackend(localDir);
  return new BaiduBackend(await baiduClientForCurrent(rt, concurrency));
}
