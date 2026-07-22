#!/usr/bin/env bun
/**
 * bz —— 敝帚命令行入口。解析参数、分发命令、把 BizhouError 映射为规范退出码。
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BizhouError } from "@bizhou/core";
import {
  cmdAccount,
  cmdInfo,
  cmdInit,
  cmdLock,
  cmdLogin,
  cmdLogout,
  cmdLs,
  cmdPasswd,
  cmdPreview,
  cmdPull,
  cmdPush,
  cmdRecover,
  cmdRm,
  cmdShare,
  cmdUnlock,
  createRuntime,
} from "./commands.ts";
import { errorLine, exitCodeFor, info, out } from "./render.ts";

const HELP = `敝帚 bz —— 客户端加密引擎 CLI

用法: bz <命令> [参数] [选项]

密钥与会话:
  init                     首次设置主密码，生成恢复密钥
  unlock [--ttl <秒>]      输入主密码解锁本设备会话（缓存主密钥）
  lock                     立即上锁（清除缓存主密钥）
  passwd                   修改主密码（恢复密钥不变）
  recover                  用恢复密钥重设主密码

账号:
  login [--name <n>] [--device] [--port <p>]   OAuth 登录百度
  logout                                       注销当前账号
  account [list|use <n>|add <n>]               多账号管理

资源:
  push <path> [--chunk 100MB] [--compress] [--no-split] [--name <n>]
  pull <id> [--out <dir>]
  ls                       列出资源（显示真名，需已解锁）
  info <id>                查看资源元数据
  rm <id>                  删除资源
  share <id> [--code|--7z] 生成分享码 / 导出 7z-AES（后者规划中）
  preview <id>             预览（规划中）

通用选项:
  --local <dir>            用本地目录代替百度网盘（离线测试/自建后端）
  --password-stdin         从 stdin 读主密码（脚本化）
  -h, --help               显示帮助
  -v, --version            显示版本

凭证: 在项目 .env 配置 BAIDU_APP_KEY / BAIDU_SECRET_KEY（见 .env.example）。`;

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // packages/cli/src → repo 根的 VERSION
    return readFileSync(join(here, "..", "..", "..", "VERSION"), "utf8").trim();
  } catch {
    return "0.0.0";
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      local: { type: "string" },
      "password-stdin": { type: "boolean" },
      out: { type: "string" },
      chunk: { type: "string" },
      compress: { type: "boolean" },
      "no-split": { type: "boolean" },
      name: { type: "string" },
      device: { type: "boolean" },
      port: { type: "string" },
      code: { type: "boolean" },
      "7z": { type: "boolean" },
      ttl: { type: "string" },
      force: { type: "boolean" },
    },
  });

  const cmd = positionals[0];
  if (values.version) {
    out(version());
    return 0;
  }
  if (!cmd || values.help) {
    info(HELP);
    return cmd ? 0 : values.help ? 0 : 1;
  }

  const common = {
    local: values.local as string | undefined,
    passwordStdin: Boolean(values["password-stdin"]),
  };
  const rt = createRuntime();

  switch (cmd) {
    case "init":
      await cmdInit(rt, { ...common, force: Boolean(values.force) });
      return 0;
    case "unlock":
      await cmdUnlock(rt, { ...common, ttl: values.ttl ? Number(values.ttl) : undefined });
      return 0;
    case "lock":
      await cmdLock(rt);
      return 0;
    case "passwd":
      await cmdPasswd(rt, common);
      return 0;
    case "recover":
      await cmdRecover(rt);
      return 0;
    case "login":
      await cmdLogin(rt, {
        name: values.name as string | undefined,
        device: Boolean(values.device),
        port: values.port ? Number(values.port) : undefined,
      });
      return 0;
    case "logout":
      await cmdLogout(rt);
      return 0;
    case "account":
      await cmdAccount(rt, positionals[1], positionals[2]);
      return 0;
    case "push":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz push <path>");
      await cmdPush(rt, positionals[1], {
        ...common,
        chunk: values.chunk as string | undefined,
        compress: Boolean(values.compress),
        noSplit: Boolean(values["no-split"]),
        name: values.name as string | undefined,
      });
      return 0;
    case "pull":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz pull <id>");
      await cmdPull(rt, positionals[1], { ...common, out: values.out as string | undefined });
      return 0;
    case "ls":
      await cmdLs(rt, common);
      return 0;
    case "info":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz info <id>");
      await cmdInfo(rt, positionals[1], common);
      return 0;
    case "rm":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz rm <id>");
      await cmdRm(rt, positionals[1], common);
      return 0;
    case "share":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz share <id>");
      await cmdShare(rt, positionals[1], {
        ...common,
        code: Boolean(values.code),
        sevenz: Boolean(values["7z"]),
      });
      return 0;
    case "preview":
      await cmdPreview();
      return 0;
    default:
      errorLine(`未知命令：${cmd}`);
      info(HELP);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof BizhouError) {
      errorLine(err.message);
      process.exit(exitCodeFor(err.code));
    }
    errorLine(`未预期错误：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
