import { describe, expect, test } from "bun:test";
import { genBash, genPowerShell, genZsh, topLevelCommandNames } from "../src/completion.ts";

describe("shell 生成器", () => {
  test("genBash：含 complete 指令、全部命令、示例 flag、动态与文件槽 hook", () => {
    const s = genBash();
    expect(s).toContain("complete -F _bz bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("--compress"); // push 的 flag
    expect(s).toContain("bz __complete backup-id"); // 动态槽
    expect(s).toContain("_filedir"); // 文件/目录槽走原生
  });

  test("genZsh：含 #compdef、全部命令、动态槽、_files", () => {
    const s = genZsh();
    expect(s).toContain("#compdef bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("bz __complete");
    expect(s).toContain("_files");
  });

  test("genPowerShell：含 Register-ArgumentCompleter、全部命令、动态槽", () => {
    const s = genPowerShell();
    expect(s).toContain("Register-ArgumentCompleter");
    expect(s).toContain("-CommandName bz");
    for (const c of topLevelCommandNames()) expect(s).toContain(c);
    expect(s).toContain("bz __complete");
  });
});
