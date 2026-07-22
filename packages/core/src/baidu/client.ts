/**
 * 百度网盘文件 API 客户端：precreate → superfile2(4MB 传输分片) → create，
 * 以及 list / filemetas / download。
 *
 * 两层分片：本工具的 100MB 逻辑分片（一个 .part 文件）在这里再按云端原生
 * 4MB 传输分片上传，复用 uploadid 断点续传。HTTP 层可注入，便于离线 mock 测试。
 */

import { createHash } from "node:crypto";
import { BizhouError } from "../errors.ts";
import type { OAuthConfig } from "./oauth.ts";

export const PAN_API = "https://pan.baidu.com/rest/2.0/xpan";
export const PCS_SUPERFILE = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
export const APP_ROOT = "/apps/bizhou";
export const TRANSFER_SLICE = 4 * 1024 * 1024; // 云端原生 4MB 传输分片

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

function sliceTransfer(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += TRANSFER_SLICE) {
    parts.push(data.subarray(off, Math.min(off + TRANSFER_SLICE, data.length)));
  }
  if (parts.length === 0) parts.push(Buffer.alloc(0)); // 空文件也要一个分片
  return parts;
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export class BaiduClient {
  constructor(
    private readonly config: OAuthConfig,
    private accessToken: string,
    private readonly http: HttpClient,
  ) {}

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
      throw new BizhouError("BAIDU", `百度文件 API 错误：method=${method} errno=${errno}`);
    }
    return data;
  }

  /** 预创建，拿 uploadid 与需上传的分片列表。 */
  async precreate(path: string, size: number, blockMd5: string[]): Promise<PrecreateResult> {
    const data = await this.fileApi("precreate", {}, form({
      path,
      size: String(size),
      isdir: "0",
      autoinit: "1",
      rtype: "3",
      block_list: JSON.stringify(blockMd5),
    }));
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
    const res = await this.http(url, { method: "POST", body: fd });
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
    const data = await this.fileApi("create", {}, form({
      path,
      size: String(size),
      isdir: "0",
      uploadid,
      rtype: "3",
      block_list: JSON.stringify(blockMd5),
    }));
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
    const need = new Set(blocksToUpload);
    for (let i = 0; i < slices.length; i++) {
      if (need.size > 0 && !need.has(i)) continue; // 已上传，跳过（续传）
      await this.uploadSlice(path, uploadid, i, slices[i]!);
      onSlice?.(i, slices.length);
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

  /** 通过 dlink 下载文件字节。 */
  async download(dlink: string): Promise<Buffer> {
    const sep = dlink.includes("?") ? "&" : "?";
    const url = `${dlink}${sep}access_token=${encodeURIComponent(this.accessToken)}`;
    const res = await this.http(url, { headers: { "User-Agent": "pan.baidu.com" } });
    if (!res.ok) {
      throw new BizhouError("BAIDU", `下载失败：HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
