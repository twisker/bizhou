import { describe, expect, test } from "bun:test";
import { cmdCompletion } from "../src/completion.ts";

async function capture(fn: () => void): Promise<string> {
  let buf = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    buf += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

describe("bz completion <shell>", () => {
  test("bash → 打印 bash 脚本", async () => {
    const out = await capture(() => cmdCompletion("bash"));
    expect(out).toContain("complete -F _bz bz");
  });
  test("zsh → 打印 zsh 脚本", async () => {
    const out = await capture(() => cmdCompletion("zsh"));
    expect(out).toContain("#compdef bz");
  });
  test("powershell → 打印 PowerShell 脚本", async () => {
    const out = await capture(() => cmdCompletion("powershell"));
    expect(out).toContain("Register-ArgumentCompleter");
  });
  test("非法/缺省 shell → 抛错列支持项", () => {
    expect(() => cmdCompletion("fish")).toThrow();
    expect(() => cmdCompletion(undefined)).toThrow();
  });
});
