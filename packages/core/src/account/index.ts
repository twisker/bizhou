/**
 * 多账号管理：每个命名账号独立的百度 token；当前账号选择；解锁后的 MK 缓存。
 * 全部经 SecretStore 加密存储。时间戳（token 过期）由调用方注入，核心库不读时钟。
 */

import { BizhouError } from "../errors.ts";
import type { SecretStore } from "../keystore/index.ts";

export interface AccountTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** 绝对过期时间戳（ms）。由 CLI 用本地时间 + expiresIn 算出。 */
  readonly expiresAt?: number;
  readonly scope?: string;
}

interface AccountsState {
  current?: string;
  accounts: Record<string, AccountTokens>;
}

const ACCOUNTS_KEY = "accounts";
const MK_CACHE_KEY = "mkCache"; // { mk: base64, expiresAt: number }

export class AccountManager {
  constructor(private readonly secrets: SecretStore) {}

  private async state(): Promise<AccountsState> {
    const raw = await this.secrets.get(ACCOUNTS_KEY);
    if (!raw) return { accounts: {} };
    return JSON.parse(raw) as AccountsState;
  }

  private async save(state: AccountsState): Promise<void> {
    await this.secrets.set(ACCOUNTS_KEY, JSON.stringify(state));
  }

  /** 新增/更新账号 token；若是首个账号则自动设为当前。 */
  async upsertAccount(name: string, tokens: AccountTokens): Promise<void> {
    if (!name) throw new BizhouError("ACCOUNT", "账号名不能为空");
    const state = await this.state();
    state.accounts[name] = tokens;
    if (!state.current) state.current = name;
    await this.save(state);
  }

  async listAccounts(): Promise<{ names: string[]; current: string | undefined }> {
    const state = await this.state();
    return { names: Object.keys(state.accounts), current: state.current };
  }

  async useAccount(name: string): Promise<void> {
    const state = await this.state();
    if (!state.accounts[name]) throw new BizhouError("ACCOUNT", `账号不存在：${name}`);
    state.current = name;
    await this.save(state);
  }

  async removeAccount(name: string): Promise<void> {
    const state = await this.state();
    if (!state.accounts[name]) throw new BizhouError("ACCOUNT", `账号不存在：${name}`);
    delete state.accounts[name];
    if (state.current === name) state.current = Object.keys(state.accounts)[0];
    await this.save(state);
  }

  async getCurrent(): Promise<{ name: string; tokens: AccountTokens } | undefined> {
    const state = await this.state();
    if (!state.current) return undefined;
    const tokens = state.accounts[state.current];
    if (!tokens) return undefined;
    return { name: state.current, tokens };
  }

  /** 更新指定账号 token（如刷新后）。 */
  async updateTokens(name: string, tokens: AccountTokens): Promise<void> {
    const state = await this.state();
    if (!state.accounts[name]) throw new BizhouError("ACCOUNT", `账号不存在：${name}`);
    state.accounts[name] = tokens;
    await this.save(state);
  }

  // ---- 解锁后的 MK 缓存（"每设备解锁一次"）--------------------------------

  /** 缓存解锁得到的 MK（base64），带绝对过期时间戳。 */
  async cacheMk(mk: Buffer, expiresAt: number): Promise<void> {
    await this.secrets.set(MK_CACHE_KEY, JSON.stringify({ mk: mk.toString("base64"), expiresAt }));
  }

  /** 读取缓存 MK；未解锁或已过期（相对传入的 now）返回 undefined。 */
  async getCachedMk(now: number): Promise<Buffer | undefined> {
    const raw = await this.secrets.get(MK_CACHE_KEY);
    if (!raw) return undefined;
    const { mk, expiresAt } = JSON.parse(raw) as { mk: string; expiresAt: number };
    if (typeof expiresAt === "number" && now > expiresAt) {
      await this.secrets.delete(MK_CACHE_KEY);
      return undefined;
    }
    return Buffer.from(mk, "base64");
  }

  /** 清除 MK 缓存（`bz lock`）。 */
  async clearMk(): Promise<void> {
    await this.secrets.delete(MK_CACHE_KEY);
  }
}
