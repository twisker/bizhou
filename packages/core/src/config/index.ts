/**
 * 配置目录解析（纯函数：env/platform 由调用方注入，核心库不直接读 process）。
 * 存放：vault.json（明文安全——只含被包裹的密钥）、secrets.enc（设备密钥加密——账号 token 与 MK 缓存）。
 */

import { join } from "node:path";

export interface Env {
  readonly HOME?: string;
  readonly USERPROFILE?: string;
  readonly APPDATA?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly BIZHOU_HOME?: string;
  readonly BIZHOU_CONFIG_DIR?: string; // 弃用别名
  readonly BIZHOU_FILE_ROOT?: string;
  readonly [key: string]: string | undefined;
}

export type Platform = "darwin" | "win32" | "linux" | string;

export const VAULT_FILENAME = "vault.json";
export const SECRETS_FILENAME = "secrets.enc";
export const DEVICE_KEY_FILENAME = "device.key";
export const CONFIG_FILENAME = "config.json";

/** 密钥根：BIZHOU_HOME > BIZHOU_CONFIG_DIR(弃用别名) > <home>/.bizhou。 */
export function resolveKeyRoot(env: Env, platform: Platform): string {
  if (env.BIZHOU_HOME) return env.BIZHOU_HOME;
  if (env.BIZHOU_CONFIG_DIR) return env.BIZHOU_CONFIG_DIR; // 弃用别名
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".bizhou");
}

/** 弃用别名，等价 resolveKeyRoot（保持旧引用不断裂）。 */
export const resolveConfigDir = resolveKeyRoot;

/** 操作系统当前用户下载目录（默认文件根）。 */
export function defaultDownloadsDir(env: Env, platform: Platform): string {
  const home = platform === "win32" ? (env.USERPROFILE ?? env.HOME ?? ".") : (env.HOME ?? ".");
  return join(home, "Downloads");
}

/** 文件根：BIZHOU_FILE_ROOT > config.json 的 fileRoot > 默认下载目录。 */
export function resolveFileRoot(env: Env, platform: Platform, configFileRoot?: string): string {
  if (env.BIZHOU_FILE_ROOT) return env.BIZHOU_FILE_ROOT;
  if (configFileRoot) return configFileRoot;
  return defaultDownloadsDir(env, platform);
}

export interface ConfigPaths {
  readonly dir: string; // 密钥根
  readonly vault: string;
  readonly secrets: string;
  readonly deviceKey: string;
  readonly config: string;
}

export function configPaths(env: Env, platform: Platform): ConfigPaths {
  const dir = resolveKeyRoot(env, platform);
  return {
    dir,
    vault: join(dir, VAULT_FILENAME),
    secrets: join(dir, SECRETS_FILENAME),
    deviceKey: join(dir, DEVICE_KEY_FILENAME),
    config: join(dir, CONFIG_FILENAME),
  };
}
