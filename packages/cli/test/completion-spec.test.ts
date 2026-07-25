import { describe, expect, test } from "bun:test";
import { COMMANDS, GLOBAL_FLAGS, topLevelCommandNames } from "../src/completion.ts";

// index.ts switch 里可分发的全部命令（含隐藏 completion；不含隐藏 __complete）。
// 新增命令时必须同步此列表与 COMMANDS，否则本测试红。
const KNOWN = [
  "init", "unlock", "lock", "passwd", "recover", "vault", "login", "logout", "quota", "account",
  "push", "pull", "mkdir", "ls", "info", "rm", "trash", "mv", "cp", "rename",
  "share", "preview", "backup", "daemon", "completion",
];

describe("命令规格表一致性", () => {
  test("COMMANDS 覆盖全部已知命令、无遗漏无多余", () => {
    const names = topLevelCommandNames().sort();
    expect(names).toEqual([...KNOWN].sort());
  });

  test("push 命令的 flag 覆盖关键项", () => {
    const push = COMMANDS.find((c) => c.name === "push");
    const flags = push?.flags.map((f) => f.name) ?? [];
    for (const f of ["--to", "--chunk", "--compress", "--no-split", "--name", "--preview", "--force", "--concurrency"]) {
      expect(flags).toContain(f);
    }
    // push 第一个位置参数是文件槽
    expect(push?.args[0]?.kind).toBe("file");
  });

  test("backup 子命令与其二级参数正确", () => {
    const backup = COMMANDS.find((c) => c.name === "backup");
    expect(backup?.args[0]).toEqual({ kind: "subcommand", names: ["add", "list", "rm", "run"] });
    expect(backup?.subArgs?.add?.[0]?.kind).toBe("dir");
    expect(backup?.subArgs?.rm?.[0]).toEqual({ kind: "dynamic", ctx: "backup-id" });
    expect(backup?.subArgs?.run?.[0]).toEqual({ kind: "dynamic", ctx: "backup-id" });
  });

  test("completion 参数是 shell 动态槽；account use 是 account 动态槽", () => {
    expect(COMMANDS.find((c) => c.name === "completion")?.args[0]).toEqual({ kind: "dynamic", ctx: "shell" });
    expect(COMMANDS.find((c) => c.name === "account")?.subArgs?.use?.[0]).toEqual({ kind: "dynamic", ctx: "account" });
  });

  test("GLOBAL_FLAGS 含 --help/--local", () => {
    const g = GLOBAL_FLAGS.map((f) => f.name);
    expect(g).toContain("--help");
    expect(g).toContain("--local");
  });
});
