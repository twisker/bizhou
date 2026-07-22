/**
 * bz 各命令实现。命令只做"编排 + 交互 + 渲染"，加密/分片/对接全在 @bizhou/core。
 */

import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  APP_ROOT,
  BizhouError,
  base32Decode,
  base32Encode,
  BaiduBundleStore,
  buildAuthorizeUrl,
  changePassword,
  createVault,
  DEFAULT_CHUNK_SIZE,
  deriveKey,
  exchangeCodeForToken,
  generateBundleId,
  generateSalt,
  groupBase32,
  openPreview,
  packResource,
  parseManifest,
  pollDeviceToken,
  readResourceMeta,
  startDeviceFlow,
  unlockWithPassword,
  unlockWithRecovery,
  unpackResource,
  unwrapDek,
  wrapKey,
} from "@bizhou/core";
import { findSevenZip, sevenZipArchive } from "./export7z.ts";
import { generatePreview } from "./preview.ts";
import { readLineFromStdin, readPassword, resolveMasterPassword } from "./prompt.ts";
import {
  baiduClientForCurrent,
  createRuntime,
  makeStore,
  type Runtime,
} from "./runtime.ts";
import { c, endProgress, formatBytes, info, ok, out, renderProgress, warn } from "./render.ts";

export interface CommonOpts {
  local?: string;
  passwordStdin?: boolean;
}

export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/i.exec(s.trim());
  if (!m) throw new BizhouError("INVALID_ARG", `无法解析大小：${s}`);
  const n = Number.parseFloat(m[1]!);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
  };
  return Math.floor(n * mult[unit]!);
}

const SHARE_PREFIX = "BZK1-";

// ---- init / unlock / lock / passwd ---------------------------------------

export async function cmdInit(rt: Runtime, opts: CommonOpts & { force?: boolean }): Promise<void> {
  if (rt.vaultExists() && !opts.force) {
    throw new BizhouError("VAULT", "已初始化（vault 已存在）。如需重置请加 --force（会使旧数据不可解！）");
  }
  const interactive =
    process.stdin.isTTY && !opts.passwordStdin && process.env.BIZHOU_MASTER_PASSWORD === undefined;
  const pw = await resolveMasterPassword("设置主密码: ", opts);
  if (!pw) throw new BizhouError("INVALID_ARG", "主密码不能为空");
  if (interactive) {
    const pw2 = await readPassword("再次输入确认: ");
    if (pw !== pw2) throw new BizhouError("INVALID_ARG", "两次输入不一致");
  }
  const { vault, recoveryKey } = await createVault(pw, { createdAt: new Date().toISOString() });
  await rt.saveVault(vault);
  ok("已初始化 vault：" + rt.paths.vault);
  info("");
  warn("以下是你的恢复密钥，只显示这一次，请离线妥善保管（忘记主密码时用它恢复）：");
  out(c.bold(recoveryKey));
  info("");
  warn("任何人拿到恢复密钥即可解开你的数据 —— 切勿上传、截图或存入云端。");
}

export async function cmdUnlock(
  rt: Runtime,
  opts: CommonOpts & { ttl?: number },
): Promise<void> {
  const vault = await rt.loadVault();
  const pw = await resolveMasterPassword("主密码: ", opts);
  const mk = await unlockWithPassword(vault, pw);
  const ttlSec = opts.ttl ?? Number(process.env.BIZHOU_UNLOCK_TTL ?? 8 * 3600);
  await rt.accounts.cacheMk(mk, Date.now() + ttlSec * 1000);
  ok(`已解锁本设备会话（${Math.round(ttlSec / 3600)} 小时后自动上锁）`);
}

export async function cmdLock(rt: Runtime): Promise<void> {
  await rt.accounts.clearMk();
  ok("已上锁（清除缓存主密钥）");
}

export async function cmdPasswd(rt: Runtime, opts: CommonOpts): Promise<void> {
  const vault = await rt.loadVault();
  const cur = await resolveMasterPassword("当前主密码: ", opts);
  const next = await readPassword("新主密码: ");
  const confirm = await readPassword("再次输入新主密码: ");
  if (next !== confirm) throw new BizhouError("INVALID_ARG", "两次输入不一致");
  const v2 = await changePassword(vault, cur, next);
  await rt.saveVault(v2);
  await rt.accounts.clearMk();
  ok("主密码已更新（恢复密钥不变；已上锁，请重新 unlock）");
}

export async function cmdRecover(rt: Runtime): Promise<void> {
  const vault = await rt.loadVault();
  info("用恢复密钥验证并重设主密码。");
  const rk = (await readPassword("恢复密钥: ")).trim();
  const mk = await unlockWithRecovery(vault, rk); // 验证恢复密钥并解出 MK
  const next = await readPassword("新主密码: ");
  const confirm = await readPassword("再次输入新主密码: ");
  if (next !== confirm) throw new BizhouError("INVALID_ARG", "两次输入不一致");
  // 用新主密码（新盐）重裹 MK，只替换 wrappedMkByPassword。
  const salt = generateSalt();
  const kek = await deriveKey(next, salt, vault.kdf);
  const v2 = { ...vault, pwSalt: salt.toString("base64"), wrappedMkByPassword: wrapKey(kek, mk) };
  await rt.saveVault(v2);
  await rt.accounts.clearMk();
  ok("已用恢复密钥重设主密码。");
}

// ---- login / logout / account --------------------------------------------

async function completeLoginToken(
  rt: Runtime,
  name: string,
  token: { accessToken: string; refreshToken?: string; expiresIn: number; scope?: string },
): Promise<void> {
  await rt.accounts.upsertAccount(name, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    scope: token.scope,
  });
  ok(`账号「${name}」登录成功。`);
}

export async function cmdLogin(
  rt: Runtime,
  opts: { name?: string; device?: boolean; port?: number },
): Promise<void> {
  const config = rt.oauthConfig();
  const name = opts.name ?? "default";
  if (opts.device) {
    const dc = await startDeviceFlow(config, rt.http);
    info(`请在浏览器打开：${c.cyan(dc.verificationUrl)}`);
    info(`并输入设备码：${c.bold(dc.userCode)}`);
    info("等待授权中…（Ctrl-C 取消）");
    const deadline = Date.now() + dc.expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, dc.interval * 1000));
      const token = await pollDeviceToken(config, dc.deviceCode, rt.http);
      if (token) {
        await completeLoginToken(rt, name, token);
        return;
      }
    }
    throw new BizhouError("OAUTH", "设备码已过期，请重试。");
  }
  // 授权码流：本地回调服务器
  const port = opts.port ?? 8899;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = buildAuthorizeUrl(config, redirectUri);
  info(`请在浏览器打开以下地址完成授权：`);
  out(url);
  const code = await waitForCallbackCode(port);
  const token = await exchangeCodeForToken(config, code, redirectUri, rt.http);
  await completeLoginToken(rt, name, token);
}

function waitForCallbackCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = u.searchParams.get("code");
      if (code) {
        res.end("敝帚：授权成功，可以关闭此页面返回终端。");
        server.close();
        resolve(code);
      } else {
        res.statusCode = 400;
        res.end("缺少 code");
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

export async function cmdLogout(rt: Runtime): Promise<void> {
  const cur = await rt.accounts.getCurrent();
  if (!cur) throw new BizhouError("ACCOUNT", "当前无登录账号");
  await rt.accounts.removeAccount(cur.name);
  ok(`账号「${cur.name}」已注销。`);
}

export async function cmdAccount(rt: Runtime, sub: string | undefined, arg?: string): Promise<void> {
  if (!sub || sub === "list") {
    const { names, current } = await rt.accounts.listAccounts();
    if (names.length === 0) {
      info("（暂无账号，先 `bz login`）");
      return;
    }
    for (const n of names) out(`${n === current ? c.green("* ") : "  "}${n}`);
    return;
  }
  if (sub === "use") {
    if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz account use <name>");
    await rt.accounts.useAccount(arg);
    ok(`已切换到账号「${arg}」`);
    return;
  }
  if (sub === "add") {
    await cmdLogin(rt, { name: arg });
    return;
  }
  throw new BizhouError("INVALID_ARG", `未知子命令：account ${sub}`);
}

// ---- push / pull / ls / info / rm ----------------------------------------

export async function cmdPush(
  rt: Runtime,
  filePath: string,
  opts: CommonOpts & {
    chunk?: string;
    compress?: boolean;
    noSplit?: boolean;
    name?: string;
    preview?: boolean;
  },
): Promise<string> {
  const st = await stat(filePath);
  if (!st.isFile()) throw new BizhouError("INVALID_ARG", `不是文件：${filePath}`);
  const mk = await rt.resolveMk(opts);
  const bundleId = generateBundleId();
  const chunkSize = opts.noSplit
    ? Math.max(st.size, 1)
    : opts.chunk
      ? parseSize(opts.chunk)
      : DEFAULT_CHUNK_SIZE;
  const store = await makeStore(rt, bundleId, opts.local);

  let preview: { kind: "video" | "audio" | "image"; data: Buffer } | undefined;
  if (opts.preview) {
    const p = await generatePreview(filePath);
    if (p) {
      preview = p;
      info(`已生成预览包（${p.kind}，${formatBytes(p.data.length)}）`);
    } else {
      warn("未生成预览（非媒体类型或 ffmpeg 不可用），继续上传原文件。");
    }
  }

  info(`加密上传：${filePath}（${formatBytes(st.size)}）→ ${bundleId}`);
  await packResource({
    filePath,
    fileSize: st.size,
    mk,
    bundleId,
    createdAt: new Date().toISOString(),
    chunkSize,
    compression: opts.compress ? "gzip" : "none",
    store,
    name: opts.name ?? basename(filePath),
    mtime: st.mtime.toISOString(),
    preview,
    onProgress: (e) => renderProgress("加密", e.bytesDone, e.bytesTotal),
  });
  endProgress();
  ok(`已上传。资源 ID：${c.bold(bundleId)}`);
  return bundleId;
}

export async function cmdPull(
  rt: Runtime,
  id: string,
  opts: CommonOpts & { out?: string },
): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const store = await makeStore(rt, id, opts.local);
  const { meta } = await readResourceMeta(mk, store);
  const outPath = join(opts.out ?? ".", meta.name);
  await mkdir(dirname(outPath), { recursive: true });
  info(`下载还原：${id} → ${outPath}（${formatBytes(meta.size)}）`);
  const res = await unpackResource({
    mk,
    store,
    outPath,
    onProgress: (e) => renderProgress("解密", e.bytesDone, e.bytesTotal),
  });
  endProgress();
  ok(`已还原 ${formatBytes(res.bytesWritten)} → ${outPath}`);
}

async function listBundleIds(rt: Runtime, local: string | undefined): Promise<string[]> {
  if (local) {
    let entries: string[] = [];
    try {
      entries = await readdir(local);
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(".bz")).map((e) => e.slice(0, -3));
  }
  const client = await baiduClientForCurrent(rt);
  const entries = await client.list(APP_ROOT);
  return entries
    .filter((e) => e.isdir && e.filename.endsWith(".bz"))
    .map((e) => e.filename.slice(0, -3));
}

export async function cmdLs(rt: Runtime, opts: CommonOpts): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const ids = await listBundleIds(rt, opts.local);
  if (ids.length === 0) {
    info("（空）");
    return;
  }
  for (const id of ids) {
    try {
      const store = await makeStore(rt, id, opts.local);
      const { meta } = await readResourceMeta(mk, store);
      out(`${c.dim(id.slice(0, 12))}  ${formatBytes(meta.size).padStart(10)}  ${meta.name}`);
    } catch {
      out(`${c.dim(id.slice(0, 12))}  ${c.yellow("(无法读取 manifest)")}`);
    }
  }
}

export async function cmdInfo(rt: Runtime, id: string, opts: CommonOpts): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const store = await makeStore(rt, id, opts.local);
  const { manifest, meta } = await readResourceMeta(mk, store);
  out(`资源 ID   : ${manifest.bundleId}`);
  out(`原文件名  : ${meta.name}`);
  out(`大小      : ${formatBytes(meta.size)}`);
  out(`创建时间  : ${manifest.createdAt}`);
  out(`加密算法  : ${manifest.cipher}`);
  out(`压缩      : ${manifest.compression}`);
  out(`分片      : ${manifest.chunks.length} 片 × ${formatBytes(manifest.chunkSize)}`);
  if (meta.mtime) out(`原修改时间: ${meta.mtime}`);
}

export async function cmdRm(rt: Runtime, id: string, opts: CommonOpts): Promise<void> {
  const store = await makeStore(rt, id, opts.local);
  await store.remove();
  ok(`已删除资源 ${id}`);
}

// ---- share / preview -----------------------------------------------------

export async function cmdShare(
  rt: Runtime,
  id: string,
  opts: CommonOpts & { code?: boolean; sevenz?: boolean; out?: string },
): Promise<void> {
  if (opts.sevenz) {
    return cmdShare7z(rt, id, opts);
  }
  // 默认 --code：导出该资源 DEK 作为分享码。
  const mk = await rt.resolveMk(opts);
  const store = await makeStore(rt, id, opts.local);
  const manifest = parseManifest(await store.getManifest());
  const dek = unwrapDek(mk, manifest.wrappedKey);
  const shareCode = SHARE_PREFIX + groupBase32(base32Encode(dek));
  info("分享码（连同云端文件夹链接交给对方；对方用敝帚 + 分享码解密该资源）：");
  out(c.bold(shareCode));
  warn("分享码等同于该资源的解密钥匙，请通过安全渠道传递。");
}

/** 把资源本地还原后重打包为头部加密的 7z-AES 单包（对方用 7-Zip + 密码即可解）。 */
async function cmdShare7z(
  rt: Runtime,
  id: string,
  opts: CommonOpts & { out?: string },
): Promise<void> {
  const bin = await findSevenZip();
  if (!bin) {
    throw new BizhouError(
      "INVALID_ARG",
      "未找到 7z 可执行文件：请安装 p7zip（brew install p7zip / apt install p7zip-full）或设置 BIZHOU_7Z_BIN",
    );
  }
  const mk = await rt.resolveMk(opts);
  const store = await makeStore(rt, id, opts.local);
  const { meta } = await readResourceMeta(mk, store);
  const work = await mkdtemp(join(tmpdir(), "bizhou-7z-"));
  try {
    const restored = join(work, meta.name);
    await unpackResource({ mk, store, outPath: restored });
    const outArchive = join(opts.out ?? ".", `${meta.name}.7z`);
    await mkdir(dirname(outArchive), { recursive: true });
    const pw = await readPassword("为 7z 包设置密码: ");
    if (!pw) throw new BizhouError("INVALID_ARG", "7z 密码不能为空");
    await sevenZipArchive(bin, outArchive, [restored], pw);
    ok(`已导出头部加密 7z：${outArchive}（对方用 7-Zip/Keka/p7zip + 密码解开）`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function cmdPreview(
  rt: Runtime,
  id: string,
  opts: CommonOpts & { out?: string },
): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const store = await makeStore(rt, id, opts.local);
  const { kind, data } = await openPreview(mk, store);
  const ext = kind === "audio" ? "mp3" : "jpg";
  const outPath = join(opts.out ?? ".", `${id.slice(0, 12)}-preview.${ext}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, data);
  ok(`预览（${kind}，${formatBytes(data.length)}）已保存：${outPath}`);
}

/** 解析分享码回 DEK（供将来 import 用；此处导出以便测试与复用）。 */
export function parseShareCode(code: string): Buffer {
  if (!code.startsWith(SHARE_PREFIX)) {
    throw new BizhouError("INVALID_ARG", "分享码格式不正确");
  }
  return base32Decode(code.slice(SHARE_PREFIX.length));
}

export { createRuntime, readLineFromStdin };
