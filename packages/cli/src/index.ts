#!/usr/bin/env node

/**
 * bz —— 敝帚命令行入口。解析参数、分发命令、把 BizhouError 映射为规范退出码。
 * 开发期用 `bun packages/cli/src/index.ts`（bun 直接跑 TS）；发布产物 dist/index.js 走 node。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BizhouError } from "@bizhou/core";
import {
  cmdAccount,
  cmdCp,
  cmdInfo,
  cmdInit,
  cmdLock,
  cmdLogin,
  cmdLogout,
  cmdLs,
  cmdMkdir,
  cmdMv,
  cmdPasswd,
  cmdPreview,
  cmdPull,
  cmdPush,
  cmdRecover,
  cmdRename,
  cmdRm,
  cmdShare,
  cmdTrash,
  cmdUnlock,
  createRuntime,
} from "./commands.ts";
import { cmdComplete, cmdCompletion } from "./completion.ts";
import { cmdBackup, cmdDaemon } from "./daemon.ts";
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
  push <path> [-r] [--chunk 100MB] [--compress] [--no-split] [--name <n>] [--preview] [--to <云端目录>] [--force] [--concurrency N]
                          （--force 无视去重/在飞锁强制上传；--concurrency 片内并发数，默认 4，范围 1-16）
  pull <id|云端目录> [-r] [--out <dir>] [--force]   还原到文件根下（--force 无视幂等/在飞锁强制下载）
  mkdir <目录>             创建云端目录（mkdir -p 语义）
  ls [目录] [-r]           列出目录（显示真名，需已解锁；-r 递归）
  info <id>                查看资源元数据
  rm <路径|id> [--yes]     删除到回收站（删除目录需 --yes 确认）
  trash [list|restore <id>|rm <id>|clear]  回收站管理（列出/恢复/永久删除/清空）
  mv <src> <目标目录>       移动 bundle 或目录到目标目录下
  cp <src> <目标目录> [-r]  复制 bundle 或目录（目录需 -r）到目标目录下
  rename <src> <新名>       改名：bundle 改真名（重写 encMeta）/ 目录 native 改名
  share <id> [--code|--7z] 生成分享码 / 导出 7z-AES（--7z 需 7z 二进制）
  preview <id> [--out <dir>]  下载并解密预览包（图片/视频缩略、音频片段）

备份/守护:
  backup add <本地目录> [--to <云端目录>]   注册加密备份任务
  backup list                              列出备份任务
  backup rm <id>                           删除备份任务（不动云端已备份数据）
  backup run [<id>]                        手动执行一次备份（省略 id 跑全部）
  daemon                                   前台守护：启动即扫 + 实时监听 + 定时兜底（Ctrl-C 退出）

其它:
  completion <bash|zsh|powershell>   输出 shell 补全脚本（eval 或写入 rc 文件）

通用选项:
  --local <dir>            用本地目录代替百度网盘（离线测试/自建后端）
  --password-stdin         从 stdin 读主密码（脚本化）
  -h, --help               显示帮助
  -v, --version            显示版本

凭证: 在项目 .env 配置 BAIDU_APP_KEY / BAIDU_SECRET_KEY（见 .env.example）。`;

// 构建期由 tsup 注入（发布产物）；开发期未定义，回退读根 VERSION 文件。
declare const __BZ_VERSION__: string | undefined;

function version(): string {
  if (typeof __BZ_VERSION__ !== "undefined" && __BZ_VERSION__) return __BZ_VERSION__;
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
      preview: { type: "boolean" },
      device: { type: "boolean" },
      port: { type: "string" },
      code: { type: "boolean" },
      "7z": { type: "boolean" },
      ttl: { type: "string" },
      force: { type: "boolean" },
      recursive: { type: "boolean", short: "r" },
      to: { type: "string" },
      yes: { type: "boolean" },
      concurrency: { type: "string" },
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
        preview: Boolean(values.preview),
        to: values.to as string | undefined,
        recursive: Boolean(values.recursive),
        force: Boolean(values.force),
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      });
      return 0;
    case "pull":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz pull <id>");
      await cmdPull(rt, positionals[1], {
        ...common,
        out: values.out as string | undefined,
        recursive: Boolean(values.recursive),
        force: Boolean(values.force),
      });
      return 0;
    case "mkdir":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz mkdir <目录>");
      await cmdMkdir(rt, positionals[1], common);
      return 0;
    case "ls":
      await cmdLs(rt, positionals[1], { ...common, recursive: Boolean(values.recursive) });
      return 0;
    case "info":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz info <id>");
      await cmdInfo(rt, positionals[1], common);
      return 0;
    case "rm":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz rm <路径|id> [--yes]");
      await cmdRm(rt, positionals[1], {
        ...common,
        yes: Boolean(values.yes),
      });
      return 0;
    case "trash":
      await cmdTrash(rt, positionals[1], positionals[2], common);
      return 0;
    case "mv":
      if (!positionals[1] || !positionals[2]) {
        throw new BizhouError("INVALID_ARG", "用法：bz mv <src> <目标目录>");
      }
      await cmdMv(rt, positionals[1], positionals[2], common);
      return 0;
    case "cp":
      if (!positionals[1] || !positionals[2]) {
        throw new BizhouError("INVALID_ARG", "用法：bz cp <src> <目标目录> [-r]");
      }
      await cmdCp(rt, positionals[1], positionals[2], {
        ...common,
        recursive: Boolean(values.recursive),
      });
      return 0;
    case "rename":
      if (!positionals[1] || !positionals[2]) {
        throw new BizhouError("INVALID_ARG", "用法：bz rename <src> <新名>");
      }
      await cmdRename(rt, positionals[1], positionals[2], common);
      return 0;
    case "share":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz share <id>");
      await cmdShare(rt, positionals[1], {
        ...common,
        code: Boolean(values.code),
        sevenz: Boolean(values["7z"]),
        out: values.out as string | undefined,
      });
      return 0;
    case "preview":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz preview <id>");
      await cmdPreview(rt, positionals[1], { ...common, out: values.out as string | undefined });
      return 0;
    case "backup":
      if (!positionals[1]) {
        throw new BizhouError("INVALID_ARG", "用法：bz backup <add|list|rm> ...");
      }
      await cmdBackup(rt, positionals[1], positionals[2], {
        ...common,
        to: values.to as string | undefined,
      });
      return 0;
    case "daemon":
      await cmdDaemon(rt, common);
      return 0;
    case "completion":
      cmdCompletion(positionals[1]);
      return 0;
    case "__complete":
      await cmdComplete(rt, positionals[1] ?? "", positionals[2]);
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
