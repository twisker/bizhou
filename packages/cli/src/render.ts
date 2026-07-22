/**
 * CLI 输出：颜色、字节格式化、进度条、退出码映射。
 * 尊重 NO_COLOR 与非 TTY（管道场景不输出 ANSI）。
 */

import type { BizhouErrorCode } from "@bizhou/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  green: (s: string) => paint("32", s),
  red: (s: string) => paint("31", s),
  yellow: (s: string) => paint("33", s),
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  cyan: (s: string) => paint("36", s),
};

export function info(msg: string): void {
  process.stderr.write(msg + "\n");
}
export function ok(msg: string): void {
  process.stderr.write(c.green("✓ ") + msg + "\n");
}
export function warn(msg: string): void {
  process.stderr.write(c.yellow("⚠ ") + msg + "\n");
}
export function errorLine(msg: string): void {
  process.stderr.write(c.red("✗ ") + msg + "\n");
}
/** 面向脚本消费的正式输出走 stdout。 */
export function out(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}

/** 单行进度渲染（覆盖同一行）。 */
export function renderProgress(label: string, done: number, total: number): void {
  if (!process.stderr.isTTY) return;
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100;
  const width = 24;
  const filled = Math.floor((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  process.stderr.write(
    `\r${label} ${c.cyan(bar)} ${pct}%  ${formatBytes(done)}/${formatBytes(total)}   `,
  );
}
export function endProgress(): void {
  if (process.stderr.isTTY) process.stderr.write("\n");
}

/** BizhouErrorCode → 退出码。 */
export function exitCodeFor(code: BizhouErrorCode | undefined): number {
  switch (code) {
    case "INVALID_ARG":
      return 2;
    case "AUTH":
      return 3;
    case "OAUTH":
      return 4;
    case "BAIDU":
      return 5;
    case "MANIFEST":
    case "BUNDLE":
    case "CHUNK":
      return 6;
    case "ACCOUNT":
    case "VAULT":
      return 7;
    default:
      return 1;
  }
}
