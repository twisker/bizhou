/**
 * 交互输入：隐藏口令读取（绝不回显、绝不记录）。
 * 自动化/测试可通过 BIZHOU_MASTER_PASSWORD 环境变量或 --password-stdin 绕过交互。
 */

import { BizhouError } from "@bizhou/core";

/** 从 stdin 读一整行（用于 --password-stdin 管道输入）。 */
export function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (ch) => (data += ch));
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    process.stdin.resume();
  });
}

/** 隐藏输入读取口令（不回显）。非 TTY 时回退为读一行。 */
export function readPassword(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLineFromStdin();
  return new Promise((resolve, reject) => {
    process.stderr.write(promptText);
    let input = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (ch: string) => {
      for (const ct of ch) {
        if (ct === "\r" || ct === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(input);
          return;
        } else if (ct === "") {
          cleanup();
          reject(new BizhouError("INVALID_ARG", "已取消"));
          return;
        } else if (ct === "" || ct === "\b") {
          input = input.slice(0, -1);
        } else if (ct >= " ") {
          input += ct;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * 解析主密码来源，优先级：--password-stdin > BIZHOU_MASTER_PASSWORD 环境变量 > 交互隐藏输入。
 */
export async function resolveMasterPassword(
  promptText: string,
  opts: { passwordStdin?: boolean } = {},
): Promise<string> {
  if (opts.passwordStdin) return readLineFromStdin();
  const fromEnv = process.env.BIZHOU_MASTER_PASSWORD;
  if (fromEnv !== undefined) return fromEnv;
  return readPassword(promptText);
}
