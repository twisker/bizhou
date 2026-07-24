import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { genBash, genPowerShell, genZsh, topLevelCommandNames } from "../src/completion.ts";

/** 在临时目录写入文件，返回绝对路径（用于把生成脚本落盘给真实 shell source）。 */
function writeTemp(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-completion-"));
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

/** 同步跑一段 shell 脚本，返回 stdout（合并 stderr 便于调试失败原因）。 */
function runShell(bin: string, scriptPath: string): { stdout: string; stderr: string } {
  const r = Bun.spawnSync([bin, scriptPath]);
  return { stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}

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

// ---------------------------------------------------------------------------
// 执行级回归测试：真实起一个 shell，source 生成脚本，模拟补全 widget 调用，
// 断言动态 hook 真正触发到位——纯字符串 contains 断言测不出 C1-T3 这类
// "自屏蔽 words / 索引错位" 问题（脚本语法仍合法，只是逻辑分支永远走不到）。
// 缺对应 shell 二进制时跳过（skipIf），不让 CI 因环境缺 shell 而变红。
// ---------------------------------------------------------------------------
describe("shell 生成器：执行级回归（真实 shell 跑生成脚本）", () => {
  const zshBin = Bun.which("zsh");
  const bashBin = Bun.which("bash");

  test.skipIf(!zshBin)("genZsh 执行：backup rm <TAB> 必须路由到 bz __complete backup-id", () => {
    const completionPath = writeTemp("_bz", genZsh());
    const harness = `
compadd() { print -l -- "COMPADD:$@"; }
_files() { print "FILES_CALLED"; }
compdef() { :; }
bz() { print "BZ $@"; }
source ${JSON.stringify(completionPath)}

words=(bz backup rm '')
CURRENT=4
_bz
`;
    const harnessPath = writeTemp("harness.zsh", harness);
    // biome-ignore lint/style/noNonNullAssertion: skipIf 已保证存在
    const { stdout, stderr } = runShell(zshBin!, harnessPath);
    expect(stderr).toBe("");
    // 旧 bug（自屏蔽 words + words[2]/CURRENT==2 索引错位）下这里恒为空输出。
    expect(stdout).toContain("BZ __complete backup-id");
  });

  test.skipIf(!zshBin)("genZsh 执行：backup <TAB> 必须给出子命令名候选", () => {
    const completionPath = writeTemp("_bz", genZsh());
    const harness = `
compadd() { print -l -- "COMPADD:$@"; }
_files() { print "FILES_CALLED"; }
compdef() { :; }
bz() { print "BZ $@"; }
source ${JSON.stringify(completionPath)}

words=(bz backup '')
CURRENT=3
_bz
`;
    const harnessPath = writeTemp("harness2.zsh", harness);
    // biome-ignore lint/style/noNonNullAssertion: skipIf 已保证存在
    const { stdout, stderr } = runShell(zshBin!, harnessPath);
    expect(stderr).toBe("");
    for (const sub of ["add", "list", "rm", "run"]) expect(stdout).toContain(sub);
    // 且不应误把 backup rm 分支或全局 flag 分支当成结果
    expect(stdout).not.toContain("BZ __complete");
  });

  test.skipIf(!bashBin)("genBash 执行：backup rm <TAB> 仍正确路由到 bz __complete backup-id（锁定不回归）", () => {
    const completionPath = writeTemp("_bz.bash", genBash());
    const harness = `
bz() { if [ "$1" = "__complete" ] && [ "$2" = "backup-id" ]; then echo MARKERID; fi; }
_filedir() { :; }
source ${JSON.stringify(completionPath)}

COMP_WORDS=(bz backup rm '')
COMP_CWORD=3
_bz
printf '%s\\n' "\${COMPREPLY[@]}"
`;
    const harnessPath = writeTemp("harness.bash", harness);
    // biome-ignore lint/style/noNonNullAssertion: skipIf 已保证存在
    const { stdout, stderr } = runShell(bashBin!, harnessPath);
    expect(stderr).toBe("");
    expect(stdout).toContain("MARKERID");
  });

  test.skipIf(!bashBin)("genBash 执行：backup <TAB> 仍正确给出子命令名候选（锁定不回归）", () => {
    const completionPath = writeTemp("_bz.bash", genBash());
    const harness = `
bz() { :; }
_filedir() { :; }
source ${JSON.stringify(completionPath)}

COMP_WORDS=(bz backup '')
COMP_CWORD=2
_bz
printf '%s\\n' "\${COMPREPLY[@]}"
`;
    const harnessPath = writeTemp("harness2.bash", harness);
    // biome-ignore lint/style/noNonNullAssertion: skipIf 已保证存在
    const { stdout, stderr } = runShell(bashBin!, harnessPath);
    expect(stderr).toBe("");
    for (const sub of ["add", "list", "rm", "run"]) expect(stdout).toContain(sub);
  });
});
