/**
 * 配置目录解析（纯函数：env/platform 由调用方注入，核心库不直接读 process）。
 * 存放：vault.json（明文安全——只含被包裹的密钥）、secrets.enc（设备密钥加密——账号 token 与 MK 缓存）。
 */

import { join } from "node:path";

export interface Env {
  readonly HOME?: string;
  readonly APPDATA?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly BIZHOU_CONFIG_DIR?: string;
  readonly [key: string]: string | undefined;
}

export type Platform = "darwin" | "win32" | "linux" | string;

/** 解析 bizhou 配置根目录。 */
export function resolveConfigDir(env: Env, platform: Platform): string {
  if (env.BIZHOU_CONFIG_DIR) return env.BIZHOU_CONFIG_DIR;
  const home = env.HOME ?? ".";
  if (platform === "darwin") return join(home, "Library", "Application Support", "bizhou");
  if (platform === "win32") return join(env.APPDATA ?? home, "bizhou");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "bizhou");
}

export const VAULT_FILENAME = "vault.json";
export const SECRETS_FILENAME = "secrets.enc";
export const DEVICE_KEY_FILENAME = "device.key";

export interface ConfigPaths {
  readonly dir: string;
  readonly vault: string;
  readonly secrets: string;
  readonly deviceKey: string;
}

export function configPaths(env: Env, platform: Platform): ConfigPaths {
  const dir = resolveConfigDir(env, platform);
  return {
    dir,
    vault: join(dir, VAULT_FILENAME),
    secrets: join(dir, SECRETS_FILENAME),
    deviceKey: join(dir, DEVICE_KEY_FILENAME),
  };
}
