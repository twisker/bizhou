/**
 * 7z-AES 导出（CLI 层，依赖 7z 可执行文件 —— 可选外部工具）。
 * 用 -mhe=on 开启头部加密（隐藏文件名），-p 设置密码；对方用 7-Zip/Keka/p7zip + 密码即可解，
 * 无需本工具。核心加密与此无关，故不污染核心库。
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { BizhouError } from "@bizhou/core";

const CANDIDATES = ["7z", "7za", "7zz"];

async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(":");
  for (const d of dirs) {
    try {
      await access(`${d}/${bin}`);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

/** 发现可用的 7z 二进制；找不到返回 null。 */
export async function findSevenZip(): Promise<string | null> {
  if (process.env.BIZHOU_7Z_BIN) return process.env.BIZHOU_7Z_BIN;
  for (const c of CANDIDATES) {
    if (await onPath(c)) return c;
  }
  return null;
}

/** 用 7z 打包并加密（头部加密隐藏文件名）。 */
export function sevenZipArchive(
  bin: string,
  outArchive: string,
  inputPaths: string[],
  password: string,
): Promise<void> {
  // 防参数注入：
  // 1) 用绝对路径（以 / 开头，绝不会被当成开关）——文件名来自解密后的原名，可能被攻击者构造为 -xxx。
  // 2) 用 7z 的 `--` 停止开关解析，其后一律按位置参数（文件）处理。
  const outAbs = resolve(outArchive);
  const inAbs = inputPaths.map((p) => resolve(p));
  return new Promise((resolvePromise, reject) => {
    const args = ["a", "-t7z", "-mhe=on", `-p${password}`, "--", outAbs, ...inAbs];
    const p = spawn(bin, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new BizhouError("IO", `7z 打包失败（退出码 ${code}）`)),
    );
  });
}
