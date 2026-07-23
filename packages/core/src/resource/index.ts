/**
 * Resource 编排：把 vault(MK) + bundle(manifest/encMeta) + chunker 串成
 * 完整的 pack（加密上传前的全部本地工作）与 unpack（下载后的还原）。
 *
 * 这是 `bz push` / `bz pull` 的可复用内核，且与存储后端无关：
 * 传入 LocalBundleStore 即离线跑通；传入 BaiduBundleStore 即联网上传下载。
 */

import { basename } from "node:path";
import {
  type Compression,
  type Manifest,
  openMeta,
  PREVIEW_FILENAME,
  type PreviewKind,
  parseManifest,
  type ResourceMeta,
  sealMeta,
  serializeManifest,
} from "../bundle/index.ts";
import { decryptChunksToFile, encryptFileToChunks } from "../chunker/index.ts";
import { aeadDecrypt, aeadEncrypt, generateKey } from "../crypto/index.ts";
import { BizhouError } from "../errors.ts";
import type { ProgressCallback } from "../events/index.ts";
import type { BundleStore } from "../store/index.ts";
import { unwrapDek, wrapDek } from "../vault/index.ts";

export const DEFAULT_CHUNK_SIZE = 100 * 1024 * 1024; // 100MB（PRD 逻辑分片默认）

export interface PackOptions {
  readonly filePath: string;
  readonly fileSize: number;
  /** MK：由 vault 解锁得到。 */
  readonly mk: Buffer;
  readonly bundleId: string;
  readonly createdAt: string;
  readonly chunkSize?: number;
  readonly compression?: Compression;
  readonly store: BundleStore;
  /** 原文件名（默认取 filePath 的 basename）。 */
  readonly name?: string;
  readonly mtime?: string;
  readonly contentType?: string;
  readonly onProgress?: ProgressCallback;
  readonly skipExisting?: readonly number[];
  /** 可选预览包（由 CLI/前端用 ffmpeg 等生成后传入；核心库只负责加密与存储）。 */
  readonly preview?: { readonly kind: PreviewKind; readonly data: Buffer };
}

/** 加密整个资源并写入 store（含 manifest）。返回 manifest。 */
export async function packResource(opts: PackOptions): Promise<Manifest> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const compression = opts.compression ?? "none";
  const dek = generateKey();

  const chunks = await encryptFileToChunks({
    filePath: opts.filePath,
    fileSize: opts.fileSize,
    dek,
    bundleId: opts.bundleId,
    chunkSize,
    compression,
    store: opts.store,
    onProgress: opts.onProgress,
    skipExisting: opts.skipExisting,
  });

  const meta: ResourceMeta = {
    name: opts.name ?? basename(opts.filePath),
    size: opts.fileSize,
    ...(opts.mtime ? { mtime: opts.mtime } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
  };

  let previewInfo: Manifest["preview"];
  if (opts.preview) {
    const { iv, ciphertext, tag } = aeadEncrypt(dek, opts.preview.data);
    await opts.store.putPreview(ciphertext);
    previewInfo = {
      file: PREVIEW_FILENAME,
      kind: opts.preview.kind,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    };
  }

  const manifest: Manifest = {
    version: 1,
    bundleId: opts.bundleId,
    createdAt: opts.createdAt,
    cipher: "AES-256-GCM",
    compression,
    chunkSize,
    wrappedKey: wrapDek(opts.mk, dek),
    chunks,
    ...(previewInfo ? { preview: previewInfo } : {}),
    encMeta: sealMeta(dek, meta),
  };
  await opts.store.putManifest(serializeManifest(manifest));
  return manifest;
}

/** 下载并解密预览包。资源无预览时抛错。 */
export async function openPreview(
  mk: Buffer,
  store: BundleStore,
): Promise<{ kind: PreviewKind; data: Buffer }> {
  const manifest = parseManifest(await store.getManifest());
  if (!manifest.preview) {
    throw new BizhouError("BUNDLE", "该资源没有预览包");
  }
  const dek = unwrapDek(mk, manifest.wrappedKey);
  const ct = await store.getPreview();
  const data = aeadDecrypt(
    dek,
    Buffer.from(manifest.preview.iv, "base64"),
    ct,
    Buffer.from(manifest.preview.tag, "base64"),
  );
  return { kind: manifest.preview.kind, data };
}

export interface UnpackOptions {
  readonly mk: Buffer;
  readonly store: BundleStore;
  readonly outPath: string;
  readonly onProgress?: ProgressCallback;
}

export interface UnpackResult {
  readonly manifest: Manifest;
  readonly meta: ResourceMeta;
  readonly bytesWritten: number;
}

/** 从 store 读 manifest → 解 DEK → 解 encMeta → 逐片还原到 outPath。 */
export async function unpackResource(opts: UnpackOptions): Promise<UnpackResult> {
  const manifest = parseManifest(await opts.store.getManifest());
  const dek = unwrapDek(opts.mk, manifest.wrappedKey);
  const meta = openMeta(dek, manifest.encMeta);
  const { bytesWritten } = await decryptChunksToFile({
    chunks: manifest.chunks,
    dek,
    bundleId: manifest.bundleId,
    compression: manifest.compression,
    store: opts.store,
    outPath: opts.outPath,
    onProgress: opts.onProgress,
  });
  return { manifest, meta, bytesWritten };
}

/** 只读 manifest 与元数据（供 `bz ls` / `bz info` 显示真名，不下载分片）。 */
export async function readResourceMeta(
  mk: Buffer,
  store: BundleStore,
): Promise<{ manifest: Manifest; meta: ResourceMeta }> {
  const manifest = parseManifest(await store.getManifest());
  const dek = unwrapDek(mk, manifest.wrappedKey);
  return { manifest, meta: openMeta(dek, manifest.encMeta) };
}

/** 改 bundle 真名（重写 encMeta，分片和 wrappedKey 不动）。 */
export async function renameResource(
  mk: Buffer,
  store: BundleStore,
  newName: string,
): Promise<void> {
  const manifest = parseManifest(await store.getManifest());
  const dek = unwrapDek(mk, manifest.wrappedKey);
  const meta = openMeta(dek, manifest.encMeta);
  const manifest2: Manifest = {
    ...manifest,
    encMeta: sealMeta(dek, { ...meta, name: newName }),
  };
  await store.putManifest(serializeManifest(manifest2));
}
