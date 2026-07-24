/**
 * bz 各命令实现。命令只做"编排 + 交互 + 渲染"，加密/分片/对接全在 @bizhou/core。
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  appendDoneChunk,
  type Backend,
  BizhouError,
  BUNDLE_SUFFIX,
  base32Decode,
  base32Encode,
  buildAuthorizeUrl,
  bundleDirName,
  type Compression,
  changePassword,
  createVault,
  DEFAULT_CHUNK_SIZE,
  defaultUploadCloudDir,
  deriveContentKey,
  deriveKey,
  downloadLocalPath,
  exchangeCodeForToken,
  generateBundleId,
  generateKey,
  generateSalt,
  getCachedManifest,
  groupBase32,
  hashPlaintextFile,
  invalidateManifest,
  isLockAlive,
  joinCloudPath,
  journalPath,
  normalizeCloudPath,
  openMeta,
  openPreview,
  type PreviewKind,
  packResource,
  parseManifest,
  pollDeviceToken,
  putCachedManifest,
  readJournal,
  readResourceMeta,
  removeJournal,
  renameResource,
  startDeviceFlow,
  unlockWithPassword,
  unlockWithRecovery,
  unpackResource,
  unwrapDek,
  wrapDek,
  wrapKey,
  writeJournal,
} from "@bizhou/core";
import { findSevenZip, sevenZipArchive } from "./export7z.ts";
import { generatePreview } from "./preview.ts";
import { readLineFromStdin, readPassword, resolveMasterPassword } from "./prompt.ts";
import { c, endProgress, formatBytes, info, ok, out, renderProgress, warn } from "./render.ts";
import { createRuntime, makeBackend, type Runtime } from "./runtime.ts";

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
    throw new BizhouError(
      "VAULT",
      "已初始化（vault 已存在）。如需重置请加 --force（会使旧数据不可解！）",
    );
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
  ok(`已初始化 vault：${rt.paths.vault}`);
  info("");
  warn("以下是你的恢复密钥，只显示这一次，请离线妥善保管（忘记主密码时用它恢复）：");
  out(c.bold(recoveryKey));
  info("");
  warn("任何人拿到恢复密钥即可解开你的数据 —— 切勿上传、截图或存入云端。");
}

export async function cmdUnlock(rt: Runtime, opts: CommonOpts & { ttl?: number }): Promise<void> {
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

export async function cmdAccount(
  rt: Runtime,
  sub: string | undefined,
  arg?: string,
): Promise<void> {
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

/** 在飞锁 TTL：拥有进程已死时，仍在此窗口内视为存活（防误判刚启动的并发/覆盖大文件长传）。 */
const UPLOAD_LOCK_TTL_MS = 30 * 60 * 1000;

/** 探测 pid 是否存活（不发信号，仅探测）；EPERM 说明进程存在但无权信号之，也算存活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** flag 覆盖 > rt 配置 > 默认 4，clamp 到 [1,16]。 */
export function resolveUploadConcurrency(rt: Runtime, flag?: number): number {
  // `--concurrency foo` → Number(...) 得 NaN；NaN ?? x 仍是 NaN（?? 只挡 null/undefined），
  // 且 Math.floor/min/max 会把 NaN 一路传播。用 Number.isFinite 显式回退到配置/默认值。
  const v = Number.isFinite(flag) ? (flag as number) : (rt.uploadConcurrency ?? 4);
  const finite = Number.isFinite(v) ? v : 4;
  return Math.min(16, Math.max(1, Math.floor(finite)));
}

/** 扫目标云端目录，返回与 targetContentId 相同的已完成 bundleId（走 manifest 缓存），无则 null。 */
async function findDuplicateBundle(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  cloudDir: string,
  targetContentId: string,
): Promise<string | null> {
  const { bundles } = await backend.listDir(cloudDir);
  for (const b of bundles) {
    let raw = await getCachedManifest(rt.paths.dir, b.id);
    if (raw === null) {
      try {
        raw = await backend.bundleStore(b.id, cloudDir).getManifest();
      } catch {
        continue; // 该 bundle 尚不完整（无 manifest）→ 跳过
      }
      await putCachedManifest(rt.paths.dir, b.id, raw);
    }
    try {
      const m = parseManifest(raw);
      const meta = openMeta(unwrapDek(mk, m.wrappedKey), m.encMeta);
      if (meta.contentId === targetContentId) return b.id;
    } catch {}
  }
  return null;
}

export interface PushOneOpts {
  chunk?: string;
  compress?: boolean;
  noSplit?: boolean;
  name?: string;
  preview?: boolean;
  force?: boolean;
}

export interface PushOneResult {
  bundleId: string;
  status: "uploaded" | "skipped-dup" | "locked" | "resumed";
}

/** 单文件上传内核：预哈希 → 去重 → 锁/续传 → packResource。cmdPush 与递归 push 共用。 */
export async function pushOneFile(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  absFile: string,
  cloudDir: string,
  opts: PushOneOpts,
): Promise<PushOneResult> {
  const st = await stat(absFile);
  const contentId = await hashPlaintextFile(absFile, contentKey);
  const jpath = journalPath(rt.paths.dir, "upload", contentId, cloudDir);

  // 云端目录必须先于去重扫描创建：BaiduBackend.listDir 对不存在的目录会抛错，
  // 若目录尚未创建（如全新账号首次推送、或递归 push 中尚未出现过的子目录），
  // 去重扫描会先于 mkdir 报错，导致首次推送失败。
  if (cloudDir !== "/") await backend.mkdir(cloudDir);

  // 1. 去重（--force 跳过）
  if (!opts.force) {
    const dup = await findDuplicateBundle(rt, backend, mk, cloudDir, contentId);
    if (dup) {
      warn(`目标已有相同文件（${c.bold(dup)}），跳过：${absFile}`);
      return { bundleId: dup, status: "skipped-dup" };
    }
  }

  // 本次调用的 flag 会得出的分片大小/压缩方式（新建时采用；续传时仅用于比对并提示）。
  const optChunkSize = opts.noSplit
    ? Math.max(st.size, 1)
    : opts.chunk
      ? parseSize(opts.chunk)
      : DEFAULT_CHUNK_SIZE;
  const optCompression: Compression = opts.compress ? "gzip" : "none";

  // 2. 查日志：锁 or 续传 or 新建
  const existing = await readJournal(jpath);
  let bundleId: string;
  let skipExisting: number[] = [];
  let status: "uploaded" | "resumed" = "uploaded";
  // DEK 必须跨续传保持一致：已上传分片是首次 DEK 的密文，manifest 也须用同一 DEK 封装。
  let dek: Buffer;
  // 分片大小/压缩方式：新建取本次 flag；续传必须沿用首次记录，否则 seq→明文映射改变，
  // 确定性 IV 会在不同明文上复用（AES-GCM nonce 复用漏洞）。
  let chunkSize: number;
  let compression: Compression;
  if (existing) {
    const alive = isLockAlive(existing, {
      ttlMs: UPLOAD_LOCK_TTL_MS,
      now: rt.now(),
      pidAlive: pidAlive(existing.pid),
    });
    if (alive && !opts.force) {
      warn(`同文件正在上传至该目录，本次跳过：${absFile}`);
      return { bundleId: existing.bundleId, status: "locked" };
    }
    // 崩溃残留（或 --force 复用）→ 续传：复用 bundleId + doneChunks + 同一 DEK + 同一分片/压缩。
    // wrappedKey/chunkSize/compression 在 JournalEntry 类型上为可选（下载日志用不到），
    // 但上传日志（本分支）在写入时（见下文 writeJournal）必写这三项；缺失即日志损坏/被篡改。
    if (
      existing.wrappedKey === undefined ||
      existing.chunkSize === undefined ||
      existing.compression === undefined
    ) {
      throw new BizhouError(
        "INVALID_ARG",
        `上传日志缺少必要字段（wrappedKey/chunkSize/compression），无法续传：${jpath}`,
      );
    }
    bundleId = existing.bundleId;
    skipExisting = existing.doneChunks;
    dek = unwrapDek(mk, existing.wrappedKey);
    status = "resumed";
    chunkSize = existing.chunkSize;
    compression = existing.compression;
    if (chunkSize !== optChunkSize || compression !== optCompression) {
      warn("续传：沿用原分片大小/压缩设置，忽略本次不同的 --chunk/--no-split/--compress");
    }
  } else {
    bundleId = generateBundleId();
    dek = generateKey();
    chunkSize = optChunkSize;
    compression = optCompression;
  }

  const totalChunks = Math.max(1, Math.ceil(st.size / chunkSize));

  const store = backend.bundleStore(bundleId, cloudDir);

  // 3. 写日志（上锁）
  await writeJournal(jpath, {
    bundleId,
    cloudDir,
    contentId,
    doneChunks: skipExisting,
    totalChunks,
    chunkSize, // 固定分片大小，续传原样沿用（杜绝确定性 IV 的 nonce 复用）
    compression, // 固定压缩方式，同上
    wrappedKey: wrapDek(mk, dek), // MK 包裹的 DEK（非裸密钥），供续传还原同一 DEK
    startedAt: new Date(rt.now()).toISOString(),
    pid: process.pid,
  });

  let preview: { kind: PreviewKind; data: Buffer } | undefined;
  if (opts.preview) {
    const p = await generatePreview(absFile);
    if (p) {
      preview = p;
      info(`已生成预览包（${p.kind}，${formatBytes(p.data.length)}）`);
    } else {
      warn("未生成预览（非媒体类型或 ffmpeg 不可用），继续上传原文件。");
    }
  }

  // onProgress 在该片 putChunk 完成之后触发，但本身是同步回调（chunker 不 await 它）。
  // 用一条串行队列把 appendDoneChunk 逐个链起来，避免并发 readJournal-writeJournal 互相覆盖，
  // 并在 packResource 结束后 await 队列，确保"进程可能被打断前，已完成分片必已落盘日志"。
  let chain: Promise<void> = Promise.resolve();
  try {
    await packResource({
      filePath: absFile,
      fileSize: st.size,
      mk,
      dek,
      bundleId,
      createdAt: new Date(rt.now()).toISOString(),
      chunkSize,
      compression,
      store,
      name: opts.name ?? basename(absFile),
      mtime: st.mtime.toISOString(),
      contentId,
      preview,
      skipExisting,
      onProgress: (e) => {
        renderProgress("加密", e.bytesDone, e.bytesTotal);
        chain = chain.then(() => appendDoneChunk(jpath, e.seq));
      },
    });
    await chain;
  } catch (err) {
    await chain.catch(() => {}); // 尽力落盘已完成分片的记录，但不掩盖原始错误
    endProgress();
    throw err; // 日志保留（doneChunks 已记），供下次续传
  }
  endProgress();
  await removeJournal(jpath); // 成功 → 释放锁
  return { bundleId, status };
}

export async function cmdPush(
  rt: Runtime,
  filePath: string,
  opts: CommonOpts & {
    chunk?: string;
    compress?: boolean;
    noSplit?: boolean;
    name?: string;
    preview?: boolean;
    to?: string;
    recursive?: boolean;
    force?: boolean;
    concurrency?: number;
  },
): Promise<string> {
  const st = await stat(filePath);
  if (opts.recursive) {
    if (!st.isDirectory()) throw new BizhouError("INVALID_ARG", `-r 需要目录：${filePath}`);
    return cmdPushRecursive(rt, filePath, opts);
  }
  if (!st.isFile()) throw new BizhouError("INVALID_ARG", `不是文件：${filePath}`);
  const mk = await rt.resolveMk(opts);
  const contentKey = deriveContentKey(mk);
  const cloudDir = opts.to
    ? normalizeCloudPath(opts.to)
    : defaultUploadCloudDir(resolve(filePath), rt.fileRoot);
  const backend = await makeBackend(rt, opts.local, resolveUploadConcurrency(rt, opts.concurrency));
  info(`加密上传：${filePath}（${formatBytes(st.size)}）→ ${cloudDir}`);
  const r = await pushOneFile(rt, backend, mk, contentKey, resolve(filePath), cloudDir, opts);
  if (r.status === "skipped-dup" || r.status === "locked") return r.bundleId;
  ok(`已上传${r.status === "resumed" ? "（续传）" : ""}。资源 ID：${c.bold(r.bundleId)}`);
  out(r.bundleId); // 完整 ID 输出到 stdout，便于脚本捕获（stderr 走进度/提示）
  return r.bundleId;
}

/** 递归收集本地目录下所有文件的绝对路径（子目录深度不限）。 */
export async function walkLocalFiles(absDir: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) result.push(p);
    }
  };
  await walk(absDir);
  return result;
}

/** `push -r`：把本地目录树逐文件复用 `pushOneFile` 打包上传到镜像的云端子目录树下（去重/续传/锁与单文件 push 一致）。 */
async function cmdPushRecursive(
  rt: Runtime,
  dirPath: string,
  opts: CommonOpts & {
    chunk?: string;
    compress?: boolean;
    noSplit?: boolean;
    to?: string;
    force?: boolean;
    concurrency?: number;
  },
): Promise<string> {
  const mk = await rt.resolveMk(opts);
  const contentKey = deriveContentKey(mk);
  const absDir = resolve(dirPath);
  // 目录本身的缺省镜像位置：取"目录当作一个条目"时的父级镜像，再把目录名接回去。
  const baseCloud = opts.to
    ? normalizeCloudPath(opts.to)
    : defaultUploadCloudDir(absDir + sep, rt.fileRoot);
  const rootCloud = joinCloudPath(baseCloud, basename(absDir));
  const backend = await makeBackend(rt, opts.local, resolveUploadConcurrency(rt, opts.concurrency));
  if (rootCloud !== "/") await backend.mkdir(rootCloud);

  const files = await walkLocalFiles(absDir);
  if (files.length === 0) {
    info(`（空目录，无文件可上传）：${absDir}`);
    return rootCloud;
  }

  let uploaded = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = relative(absDir, abs);
    const relDir = dirname(rel);
    const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
    info(`加密上传：${abs} → ${cloudDir}/${basename(abs)}`);
    const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, opts);
    if (r.status === "skipped-dup") skipped++;
    else if (r.status === "locked") {
      /* 跳过，不计入上传 */
    } else uploaded++;
    if (r.status === "uploaded" || r.status === "resumed") ok(`已上传：${rel} → ${r.bundleId}`);
  }
  ok(
    `整树完成：上传 ${uploaded}，跳过（已存在）${skipped}，共 ${files.length} 个文件 → ${rootCloud}`,
  );
  return rootCloud;
}

/** 在飞锁 TTL：同上传，防误判刚启动的并发/长下载。 */
const DOWNLOAD_LOCK_TTL_MS = 30 * 60 * 1000;

/** 下载日志键：新 bundle 用 contentId，旧 bundle（无 contentId）退回 bundleId。 */
function downloadJournalKey(contentId: string | undefined, bundleId: string): string {
  return contentId && contentId.length > 0 ? contentId : bundleId;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface PullOneOpts {
  force?: boolean;
}

export interface PullOneResult {
  status: "restored" | "skipped-dup" | "locked" | "resumed";
  bytesWritten: number;
}

/** 单 bundle 下载内核：幂等→锁/续传→解密到 .part→端到端校验→原子改名。cmdPull 与 pull -r 共用。 */
export async function pullOneBundle(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  fullId: string,
  dir: string,
  outPath: string,
  opts: PullOneOpts,
): Promise<PullOneResult> {
  const store = backend.bundleStore(fullId, dir);
  const { manifest, meta } = await readResourceMeta(mk, store);
  const cid = meta.contentId; // 可能 undefined（旧 bundle）
  const jkey = downloadJournalKey(cid, fullId);
  const jpath = journalPath(rt.paths.dir, "download", jkey, outPath);
  const partPath = `${outPath}.part`;

  // 1. 幂等：目标已存在且内容相同 → 跳过（仅当有 contentId 可比对）
  if (!opts.force && cid && (await fileExists(outPath))) {
    if ((await hashPlaintextFile(outPath, contentKey)) === cid) {
      warn(`目标已有相同文件，跳过：${outPath}`);
      return { status: "skipped-dup", bytesWritten: 0 };
    }
  }

  // 2. 查下载日志：锁 or 续传 or 新建
  const existing = await readJournal(jpath);
  let skip: number[] = [];
  let status: "restored" | "resumed" = "restored";
  if (existing) {
    const alive = isLockAlive(existing, {
      ttlMs: DOWNLOAD_LOCK_TTL_MS,
      now: rt.now(),
      pidAlive: pidAlive(existing.pid),
    });
    if (alive && !opts.force) {
      warn(`同文件正在下载，本次跳过：${outPath}`);
      return { status: "locked", bytesWritten: 0 };
    }
    // 崩溃残留（或 --force）→ 续传，但仅当 .part 仍在；否则从头
    if (await fileExists(partPath)) {
      skip = existing.doneChunks;
      status = "resumed";
    }
  }

  await mkdir(dirname(outPath), { recursive: true });

  // 3. 写日志（上锁）
  await writeJournal(jpath, {
    bundleId: fullId,
    cloudDir: dir,
    contentId: cid ?? "",
    doneChunks: skip,
    totalChunks: manifest.chunks.length,
    startedAt: new Date(rt.now()).toISOString(),
    pid: process.pid,
  });

  // 4. 解密到 .part；每片写完把 seq 追加进日志（串行链，err-on-safe：日志滞后只会重下，绝不跳缺片）
  let chain: Promise<void> = Promise.resolve();
  let bytesWritten = 0;
  try {
    const res = await unpackResource({
      mk,
      store,
      outPath: partPath,
      skip,
      onProgress: (e) => {
        renderProgress("解密", e.bytesDone, e.bytesTotal);
        chain = chain.then(() => appendDoneChunk(jpath, e.seq));
      },
    });
    bytesWritten = res.bytesWritten;
    await chain; // 确保进度落盘日志
  } catch (err) {
    endProgress();
    await chain.catch(() => {});
    throw err; // .part 与日志保留，供续传
  }
  endProgress();

  // 5. 端到端校验（有 contentId 才做）：装配文件必须字节等于上传物
  if (cid) {
    const got = await hashPlaintextFile(partPath, contentKey);
    if (got !== cid) {
      throw new BizhouError(
        "CHUNK",
        `下载文件 contentId 校验失败（数据不完整或损坏），未交付：${outPath}`,
      );
      // 注意：不 removeJournal、不 rename → 保留 .part 与日志供重试
    }
  }

  // 6. 原子改名落地 + 释放锁
  await rename(partPath, outPath);
  await removeJournal(jpath);
  return { status, bytesWritten };
}

export async function cmdPull(
  rt: Runtime,
  id: string,
  opts: CommonOpts & { out?: string; recursive?: boolean; force?: boolean },
): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const backend = await makeBackend(rt, opts.local);

  if (opts.recursive) {
    const startDir = normalizeCloudPath(id);
    const bundles = await walkBundlesUnder(backend, startDir);
    if (bundles.length === 0) {
      info(`（空）云端目录下无资源：${startDir}`);
      return;
    }
    const contentKey = deriveContentKey(mk);
    let restored = 0;
    let skipped = 0;
    for (const b of bundles) {
      const { meta } = await readResourceMeta(mk, backend.bundleStore(b.id, b.dir));
      const outPath = downloadLocalPath(rt.fileRoot, b.dir, meta.name);
      info(`下载还原：${b.id} → ${outPath}（${formatBytes(meta.size)}）`);
      const r = await pullOneBundle(rt, backend, mk, contentKey, b.id, b.dir, outPath, opts);
      if (r.status === "skipped-dup") skipped++;
      else if (r.status === "locked") {
        /* 跳过，不计 */
      } else {
        restored++;
        ok(
          `已还原${r.status === "resumed" ? "（续传）" : ""} ${formatBytes(r.bytesWritten)} → ${outPath}`,
        );
      }
    }
    ok(
      `整树还原完成：还原 ${restored}，跳过（已存在）${skipped}，共 ${bundles.length} 个 → ${rt.fileRoot}`,
    );
    return;
  }

  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const { meta } = await readResourceMeta(mk, backend.bundleStore(fullId, dir));
  // 两个分支都经 downloadLocalPath（会 normalize 目录段、拒绝 '..'，并 basename 净化 name），
  // 杜绝 --out 或 meta.name 里的 ../ 逃逸文件根。--out 给定时用它作落点子目录，否则用 bundle 云端目录。
  const outPath = downloadLocalPath(rt.fileRoot, opts.out ?? dir, meta.name);
  const contentKey = deriveContentKey(mk);
  info(`下载还原：${fullId} → ${outPath}（${formatBytes(meta.size)}）`);
  const r = await pullOneBundle(rt, backend, mk, contentKey, fullId, dir, outPath, opts);
  if (r.status === "skipped-dup" || r.status === "locked") return;
  ok(
    `已还原${r.status === "resumed" ? "（续传）" : ""} ${formatBytes(r.bytesWritten)} → ${outPath}`,
  );
}

/** 递归列出某云端目录子树下所有 bundle 的 `{id, dir}`。 */
export async function walkBundlesUnder(
  backend: Backend,
  startDir: string,
): Promise<{ id: string; dir: string }[]> {
  const result: { id: string; dir: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const listing = await backend.listDir(dir);
    result.push(...listing.bundles);
    for (const d of listing.dirs) {
      await walk(dir === "/" ? `/${d}` : `${dir}/${d}`);
    }
  };
  await walk(startDir);
  return result;
}

/**
 * 递归列出整棵云端树里所有 bundle 的 `{id, dir}`（从根 `/` 开始）。
 * `backend` 可选：调用方若已建好 backend，传入以避免重复 makeBackend（重复走 token 刷新）。
 */
async function listBundles(
  rt: Runtime,
  local: string | undefined,
  backend?: Backend,
): Promise<{ id: string; dir: string }[]> {
  const b = backend ?? (await makeBackend(rt, local));
  return walkBundlesUnder(b, "/");
}

/** 把用户给的 ID（可为 `bz ls` 显示的 12 位前缀）解析为完整 bundle，递归遍历子目录查找。 */
async function resolveBundle(
  rt: Runtime,
  idOrPrefix: string,
  local: string | undefined,
  backend?: Backend,
): Promise<{ id: string; dir: string }> {
  const bundles = await listBundles(rt, local, backend);
  if (/^[0-9a-f]{32}$/.test(idOrPrefix)) {
    const found = bundles.find((b) => b.id === idOrPrefix);
    if (!found) throw new BizhouError("INVALID_ARG", `找不到资源：${idOrPrefix}`);
    return found;
  }
  const matches = bundles.filter((b) => b.id.startsWith(idOrPrefix.toLowerCase()));
  if (matches.length === 0) throw new BizhouError("INVALID_ARG", `找不到资源：${idOrPrefix}`);
  if (matches.length > 1) {
    throw new BizhouError(
      "INVALID_ARG",
      `ID 前缀 ${idOrPrefix} 不唯一（匹配 ${matches.length} 个），请给更长前缀`,
    );
  }
  return matches[0]!;
}

/**
 * 解析 bundle：确实找不到→返回 null（供上层回退为目录路径）；歧义/后端错误→抛出（不吞）。
 * 与 `resolveBundle` 的区别：后者对"找不到"也抛错，本函数只对"找不到"返回 null，
 * 让 mv/cp/rename 能安全区分"当目录处理"与"歧义/网络错误应如实报错"两种情形。
 */
export async function resolveBundleOrNull(
  rt: Runtime,
  idOrPrefix: string,
  local: string | undefined,
  backend?: Backend,
): Promise<{ id: string; dir: string } | null> {
  const bundles = await listBundles(rt, local, backend); // 后端错误在此自然抛出（不被吞）
  const full = /^[0-9a-f]{32}$/.test(idOrPrefix)
    ? bundles.filter((b) => b.id === idOrPrefix)
    : bundles.filter((b) => b.id.startsWith(idOrPrefix.toLowerCase()));
  if (full.length === 0) return null; // 确实找不到
  if (full.length > 1) {
    throw new BizhouError(
      "INVALID_ARG",
      `ID 前缀 ${idOrPrefix} 不唯一（匹配 ${full.length} 个），请给更长前缀`,
    );
  }
  return full[0]!;
}

export async function cmdMkdir(rt: Runtime, cloudDir: string, opts: CommonOpts): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  await backend.mkdir(normalizeCloudPath(cloudDir));
  ok(`已创建目录 ${normalizeCloudPath(cloudDir)}`);
}

export async function cmdLs(
  rt: Runtime,
  cloudDir: string | undefined,
  opts: CommonOpts & { recursive?: boolean },
): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const backend = await makeBackend(rt, opts.local);
  const start = normalizeCloudPath(cloudDir ?? "/");

  let printedAny = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    const listing = await backend.listDir(dir);
    for (const d of listing.dirs.sort()) {
      printedAny = true;
      out(`${"  ".repeat(depth)}${c.cyan(`${d}/`)}`);
      if (opts.recursive) await walk(dir === "/" ? `/${d}` : `${dir}/${d}`, depth + 1);
    }
    for (const b of listing.bundles) {
      printedAny = true;
      try {
        const store = backend.bundleStore(b.id, dir);
        const { meta } = await readResourceMeta(mk, store);
        out(
          `${"  ".repeat(depth)}${c.dim(b.id.slice(0, 12))}  ${formatBytes(meta.size).padStart(10)}  ${meta.name}`,
        );
      } catch {
        out(`${"  ".repeat(depth)}${c.dim(b.id.slice(0, 12))}  ${c.yellow("(无法读取)")}`);
      }
    }
  };
  await walk(start, 0);
  if (!printedAny) info("（空）");
}

export async function cmdInfo(rt: Runtime, id: string, opts: CommonOpts): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const backend = await makeBackend(rt, opts.local);
  const store = backend.bundleStore(fullId, dir);
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

export async function cmdRm(
  rt: Runtime,
  src: string,
  opts: CommonOpts & { recursive?: boolean; yes?: boolean },
): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  const b = await resolveBundleOrNull(rt, src, opts.local, backend);
  const isBundle = b !== null;
  const path = b ? joinCloudPath(b.dir, bundleDirName(b.id)) : normalizeCloudPath(src);
  if (!isBundle && !opts.yes) {
    throw new BizhouError("INVALID_ARG", `删除目录 ${path} 及其内容将进回收站，请加 --yes 确认`);
  }
  await backend.trashPath(path, new Date().toISOString());
  if (isBundle) await invalidateManifest(rt.paths.dir, b.id);
  ok(`已删除到回收站：${isBundle ? b.id : path}`);
}

export async function cmdTrash(
  rt: Runtime,
  sub: string | undefined,
  arg: string | undefined,
  opts: CommonOpts,
): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  if (!sub || sub === "list") {
    const entries = await backend.listTrash();
    if (entries.length === 0) {
      info("（回收站为空）");
      return;
    }
    for (const e of entries) {
      out(`${e.entryId}  ${e.name}  ${e.originalPath}  ${e.deletedAt}`);
    }
    return;
  }
  if (sub === "restore") {
    if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz trash restore <entryId>");
    await backend.restoreTrash(arg);
    ok(`已从回收站恢复：${arg}`);
    return;
  }
  if (sub === "rm") {
    if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz trash rm <entryId>");
    const entries = await backend.listTrash();
    const entry = entries.find((e) => e.entryId === arg);
    await backend.deleteTrash(arg);
    if (entry?.name.endsWith(BUNDLE_SUFFIX)) {
      await invalidateManifest(rt.paths.dir, entry.name.slice(0, -BUNDLE_SUFFIX.length));
    }
    ok(`已从回收站永久删除：${arg}`);
    return;
  }
  if (sub === "clear") {
    await backend.clearTrash();
    // clear 时涉及的 bundleId 不易逐一枚举：直接清空整个 manifest 缓存目录（简单且安全，最坏情况只是下次重新拉取）。
    await rm(join(rt.paths.dir, ".cache", "manifests"), { recursive: true, force: true });
    ok("回收站已清空");
    return;
  }
  throw new BizhouError("INVALID_ARG", `未知子命令：trash ${sub}`);
}

// ---- mv / cp / rename ------------------------------------------------------

export async function cmdMv(
  rt: Runtime,
  src: string,
  dstDir: string,
  opts: CommonOpts,
): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  const b = await resolveBundleOrNull(rt, src, opts.local, backend);
  const srcPath = b ? joinCloudPath(b.dir, bundleDirName(b.id)) : normalizeCloudPath(src);
  const dst = normalizeCloudPath(dstDir);
  await backend.mkdir(dst);
  await backend.move(srcPath, dst);
  ok(`已移动 ${srcPath} → ${dst}`);
}

export async function cmdCp(
  rt: Runtime,
  src: string,
  dstDir: string,
  opts: CommonOpts & { recursive?: boolean },
): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  const b = await resolveBundleOrNull(rt, src, opts.local, backend);
  const isBundle = b !== null;
  const srcPath = b ? joinCloudPath(b.dir, bundleDirName(b.id)) : normalizeCloudPath(src);
  if (!isBundle && !opts.recursive) {
    throw new BizhouError("INVALID_ARG", "复制目录需 -r");
  }
  const dst = normalizeCloudPath(dstDir);
  await backend.mkdir(dst);
  await backend.copy(srcPath, dst);
  ok(`已复制 ${srcPath} → ${dst}`);
}

export async function cmdRename(
  rt: Runtime,
  src: string,
  newName: string,
  opts: CommonOpts,
): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  const b = await resolveBundleOrNull(rt, src, opts.local, backend);
  if (b) {
    const mk = await rt.resolveMk(opts);
    const bundleStore = backend.bundleStore(b.id, b.dir);
    await renameResource(mk, bundleStore, newName);
    await invalidateManifest(rt.paths.dir, b.id); // 改名改了 encMeta，须失效缓存
    ok(`已改名 ${b.id} → ${newName}`);
    return;
  }
  const srcPath = normalizeCloudPath(src);
  await backend.rename(srcPath, newName);
  ok(`已改名 ${srcPath} → ${newName}`);
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
  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const backend = await makeBackend(rt, opts.local);
  const store = backend.bundleStore(fullId, dir);
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
  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const backend = await makeBackend(rt, opts.local);
  const store = backend.bundleStore(fullId, dir);
  const { meta } = await readResourceMeta(mk, store);
  const work = await mkdtemp(join(tmpdir(), "bizhou-7z-"));
  try {
    const restored = join(work, meta.name);
    await unpackResource({ mk, store, outPath: restored });
    const outArchive = join(opts.out ?? ".", `${meta.name}.7z`);
    await mkdir(dirname(outArchive), { recursive: true });
    const pw = process.env.BIZHOU_SHARE_PASSWORD ?? (await readPassword("为 7z 包设置密码: "));
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
  const { id: fullId, dir } = await resolveBundle(rt, id, opts.local);
  const backend = await makeBackend(rt, opts.local);
  const store = backend.bundleStore(fullId, dir);
  const { kind, data } = await openPreview(mk, store);
  const ext = kind === "audio" ? "mp3" : "jpg";
  const outPath = join(opts.out ?? ".", `${fullId.slice(0, 12)}-preview.${ext}`);
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
