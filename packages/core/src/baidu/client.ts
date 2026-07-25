/**
 * 百度网盘文件 API 客户端：precreate → superfile2(4MB 传输分片) → create，
 * 以及 list / filemetas / download。
 *
 * 两层分片：本工具的 100MB 逻辑分片（一个 .part 文件）在这里再按云端原生
 * 4MB 传输分片上传，复用 uploadid 断点续传。HTTP 层可注入，便于离线 mock 测试。
 */

import { createHash } from "node:crypto";
import { BaiduApiError, BizhouError } from "../errors.ts";
import type { OAuthConfig } from "./oauth.ts";

export const PAN_API = "https://pan.baidu.com/rest/2.0/xpan";
export const PCS_SUPERFILE = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
/** 配额接口不在 xpan 命名空间下，是独立的 /api/quota。 */
export const PAN_QUOTA_API = "https://pan.baidu.com/api/quota";
export const APP_ROOT = "/apps/bizhou";
export const TRANSFER_SLICE = 4 * 1024 * 1024; // 云端原生 4MB 传输分片

/**
 * xpan `list`/`filemetas` 等接口对"路径不存在"返回的 errno。这是第三方对接项目
 * （AlistGo/OpenListTeam 等）在生产环境里验证到的行为，百度官方文档未见正式列出，
 * 因此只把它当作"确定不存在"的唯一识别信号——任何其它 errno（鉴权失败、限流、
 * 参数错误……）都必须当作真失败处理，绝不可归入"不存在"。
 */
export const ERRNO_PATH_NOT_FOUND = -9;

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | FormData;
  signal?: AbortSignal;
}

export type HttpClient = (input: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export interface RemoteEntry {
  readonly fsId: number;
  readonly path: string;
  readonly filename: string;
  readonly size: number;
  readonly isdir: boolean;
}

export interface PrecreateResult {
  readonly uploadid: string;
  /** 仍需上传的传输分片 seq 列表（断点续传：已存在的不在其中）。 */
  readonly blocksToUpload: number[];
}

function md5hex(b: Buffer): string {
  return createHash("md5").update(b).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 瞬时失败重试（指数退避）。用于上传/下载这类走 d.pcs 的网络重操作——
 * 单个 4MB 分片偶发超时不应中断整份大文件。上传分片按 partseq+uploadid 幂等，重试安全。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    tries?: number;
    baseMs?: number;
    onRetry?: (attempt: number, err: unknown) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    if (opts.signal?.aborted) throw lastErr ?? new BizhouError("BAIDU", "上传已取消");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err; // 已取消：不再退避重试
      if (i < tries - 1) {
        opts.onRetry?.(i + 1, err);
        await sleep(baseMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}

function sliceTransfer(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += TRANSFER_SLICE) {
    parts.push(data.subarray(off, Math.min(off + TRANSFER_SLICE, data.length)));
  }
  if (parts.length === 0) parts.push(Buffer.alloc(0)); // 空文件也要一个分片
  return parts;
}

/** 路径最后一段（basename），仅字符串操作，不依赖 cloudpath（client 只处理绝对远端路径）。 */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export class BaiduClient {
  private readonly maxRetries: number;
  private readonly uploadConcurrency: number;

  constructor(
    readonly _config: OAuthConfig,
    private accessToken: string,
    private readonly http: HttpClient,
    opts: { maxRetries?: number; uploadConcurrency?: number } = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.uploadConcurrency = Math.min(16, Math.max(1, opts.uploadConcurrency ?? 4));
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private async fileApi(
    method: string,
    query: Record<string, string>,
    body?: string,
  ): Promise<Record<string, unknown>> {
    const url = `${PAN_API}/file?${form({ method, access_token: this.accessToken, ...query })}`;
    const res = await this.http(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body,
    });
    const data = (await res.json()) as Record<string, unknown>;
    const errno = data.errno;
    if (typeof errno === "number" && errno !== 0) {
      throw new BaiduApiError(errno, `百度文件 API 错误：method=${method} errno=${errno}`);
    }
    return data;
  }

  /** 预创建，拿 uploadid 与需上传的分片列表。 */
  async precreate(path: string, size: number, blockMd5: string[]): Promise<PrecreateResult> {
    const data = await this.fileApi(
      "precreate",
      {},
      form({
        path,
        size: String(size),
        isdir: "0",
        autoinit: "1",
        rtype: "3",
        block_list: JSON.stringify(blockMd5),
      }),
    );
    if (typeof data.uploadid !== "string") {
      throw new BizhouError("BAIDU", "precreate 未返回 uploadid");
    }
    const blocks = Array.isArray(data.block_list)
      ? (data.block_list as number[])
      : blockMd5.map((_, i) => i);
    return { uploadid: data.uploadid, blocksToUpload: blocks };
  }

  /** 上传一个 4MB 传输分片，返回其 md5。 */
  async uploadSlice(
    path: string,
    uploadid: string,
    partseq: number,
    slice: Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${PCS_SUPERFILE}?${form({
      method: "upload",
      access_token: this.accessToken,
      type: "tmpfile",
      path,
      uploadid,
      partseq: String(partseq),
    })}`;
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(slice)]), "part");
    const res = await this.http(url, { method: "POST", body: fd, signal });
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.md5 !== "string") {
      throw new BizhouError("BAIDU", `superfile2 分片 ${partseq} 未返回 md5`);
    }
    return data.md5;
  }

  /** 合并落盘。 */
  async create(
    path: string,
    size: number,
    uploadid: string,
    blockMd5: string[],
  ): Promise<{ fsId?: number }> {
    const data = await this.fileApi(
      "create",
      {},
      form({
        path,
        size: String(size),
        isdir: "0",
        uploadid,
        rtype: "3",
        block_list: JSON.stringify(blockMd5),
      }),
    );
    return { fsId: typeof data.fs_id === "number" ? data.fs_id : undefined };
  }

  /**
   * 上传一个逻辑分片文件（≤100MB）到 path：precreate → 逐 4MB superfile2 → create。
   * 复用 uploadid，precreate 返回的 blocksToUpload 天然支持断点续传。
   */
  async uploadPart(
    path: string,
    data: Buffer,
    onSlice?: (partseq: number, total: number) => void,
  ): Promise<{ fsId?: number }> {
    const slices = sliceTransfer(data);
    const blockMd5 = slices.map(md5hex);
    const { uploadid, blocksToUpload } = await this.precreate(path, data.length, blockMd5);
    // 仅上传仍需的分片（断点续传 / 秒传时可能为空）。
    const need = blocksToUpload.filter((i) => i >= 0 && i < slices.length);
    const total = slices.length;

    const ac = new AbortController();
    let nextK = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (ac.signal.aborted) return;
        const k = nextK++;
        if (k >= need.length) return;
        const i = need[k]!;
        // 单片幂等：同 partseq+uploadid 可重传；aborted 时 withRetry 不再重试。
        await withRetry(() => this.uploadSlice(path, uploadid, i, slices[i]!, ac.signal), {
          tries: this.maxRetries,
          signal: ac.signal,
        });
        onSlice?.(i, total);
      }
    };

    const poolN = Math.min(this.uploadConcurrency, Math.max(1, need.length));
    try {
      await Promise.all(Array.from({ length: poolN }, () => worker()));
    } catch (err) {
      ac.abort(); // fail-fast：取消在飞分片
      throw err; // 不调 create，逻辑分片视为未完成
    }
    return this.create(path, data.length, uploadid, blockMd5);
  }

  /** 列目录。 */
  async list(dir: string): Promise<RemoteEntry[]> {
    const data = await this.fileApi("list", { dir, order: "name" });
    const list = Array.isArray(data.list) ? (data.list as Record<string, unknown>[]) : [];
    return list.map((e) => ({
      fsId: Number(e.fs_id),
      path: String(e.path),
      filename: String(e.server_filename ?? e.filename ?? ""),
      size: Number(e.size ?? 0),
      isdir: Number(e.isdir ?? 0) === 1,
    }));
  }

  /** 取 dlink（下载直链）。 */
  async filemetas(fsIds: number[]): Promise<{ fsId: number; dlink: string; filename: string }[]> {
    const url = `${PAN_API}/multimedia?${form({
      method: "filemetas",
      access_token: this.accessToken,
      fsids: JSON.stringify(fsIds),
      dlink: "1",
    })}`;
    const res = await this.http(url);
    const data = (await res.json()) as Record<string, unknown>;
    const errno = data.errno;
    if (typeof errno === "number" && errno !== 0) {
      throw new BizhouError("BAIDU", `filemetas 错误 errno=${errno}`);
    }
    const list = Array.isArray(data.list) ? (data.list as Record<string, unknown>[]) : [];
    return list.map((e) => ({
      fsId: Number(e.fs_id),
      dlink: String(e.dlink ?? ""),
      filename: String(e.filename ?? e.server_filename ?? ""),
    }));
  }

  /** filemanager 通用封装：POST filemanager?opera=... body async=0&filelist=[...]。 */
  private async fileManagerOp(opera: string, filelist: unknown[]): Promise<void> {
    await this.fileApi(
      "filemanager",
      { opera },
      form({ async: "0", filelist: JSON.stringify(filelist), ondup: "fail" }),
    );
  }

  /** 删除远端路径（文件或目录）。 */
  async deletePaths(paths: string[]): Promise<void> {
    await this.fileManagerOp("delete", paths);
  }

  /** 移动 srcPath 到 dstDir 下（目录级，保留原名）。 */
  async move(srcPath: string, dstDir: string): Promise<void> {
    await this.fileManagerOp("move", [
      { path: srcPath, dest: dstDir, newname: lastSegment(srcPath) },
    ]);
  }

  /** 复制 srcPath 到 dstDir 下（目录级，保留原名；源保留）。 */
  async copy(srcPath: string, dstDir: string): Promise<void> {
    await this.fileManagerOp("copy", [
      { path: srcPath, dest: dstDir, newname: lastSegment(srcPath) },
    ]);
  }

  /** 原地改名（同目录下改末段名）。 */
  async rename(srcPath: string, newName: string): Promise<void> {
    await this.fileManagerOp("rename", [{ path: srcPath, newname: newName }]);
  }

  /**
   * 网盘配额（E-7）：返回总量与已用字节。
   *
   * 失败一律抛错，绝不回落成 0——这个数字要直接显示给用户，`0` 会被读成
   * "网盘是空的"或"一点空间都没有"，比一条报错难排查得多。
   */
  async getQuota(): Promise<{ total: number; used: number }> {
    const url = `${PAN_QUOTA_API}?${form({
      access_token: this.accessToken,
      checkfree: "1",
      checkexpire: "1",
    })}`;
    // 只对传输层退避重试。errno 与字段缺失是确定性的答复，重试三次只是白等 1.5 秒
    // 并多打三次接口，答案不会变。
    const data = await withRetry(
      async () => (await this.http(url)).json() as Promise<Record<string, unknown>>,
      { tries: this.maxRetries },
    );
    const errno = data.errno;
    if (typeof errno === "number" && errno !== 0) {
      throw new BaiduApiError(errno, `配额查询失败 errno=${errno}`);
    }
    if (typeof data.total !== "number" || typeof data.used !== "number") {
      throw new BizhouError("BAIDU", "配额查询返回的字段不完整（缺 total/used）");
    }
    return { total: data.total, used: data.used };
  }

  /** 创建目录（xpan create isdir=1，等价 mkdir -p）。 */
  async mkdir(path: string): Promise<void> {
    await this.fileApi("create", {}, form({ path, isdir: "1", rtype: "3" }));
  }

  /** 通过 dlink 下载文件字节（瞬时失败重试）。 */
  async download(dlink: string): Promise<Buffer> {
    const sep = dlink.includes("?") ? "&" : "?";
    const url = `${dlink}${sep}access_token=${encodeURIComponent(this.accessToken)}`;
    return withRetry(
      async () => {
        const res = await this.http(url, { headers: { "User-Agent": "pan.baidu.com" } });
        if (!res.ok) {
          throw new BizhouError("BAIDU", `下载失败：HTTP ${res.status}`);
        }
        return Buffer.from(await res.arrayBuffer());
      },
      { tries: this.maxRetries },
    );
  }
}
