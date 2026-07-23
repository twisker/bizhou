/**
 * 分片器：把文件按 chunkSize 切片，逐片（可选压缩→）AES-256-GCM 加密后写入 store；
 * 以及反向：逐片读出、校验 sha256、解密、（可选解压→）写回，重组还原。
 *
 * 内存占用与文件总大小解耦：任一时刻只有一个分片（默认 100MB）驻留内存，
 * 通过文件句柄按位置分片读取，满足 PRD"大文件不阻塞、内存不随文件线性增长"。
 * （worker_threads 并行加密属性能优化，后续 Sprint 引入；此处正确性优先。）
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { type ChunkInfo, type Compression, chunkAad, chunkFileName } from "../bundle/index.ts";
import { aeadDecrypt, aeadEncrypt, deriveDeterministicIv } from "../crypto/index.ts";
import { BizhouError } from "../errors.ts";
import type { ProgressCallback } from "../events/index.ts";
import type { BundleStore } from "../store/index.ts";

function sha256hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export interface EncryptFileOptions {
  readonly filePath: string;
  readonly fileSize: number;
  readonly dek: Buffer;
  readonly bundleId: string;
  readonly chunkSize: number;
  readonly compression: Compression;
  readonly store: BundleStore;
  readonly onProgress?: ProgressCallback;
  /** 断点续传：这些 seq 已存在于 store，跳过写入（仍参与 manifest 与进度）。 */
  readonly skipExisting?: readonly number[];
}

/** 加密并分片写入 store，返回 ChunkInfo[]（供组装 manifest）。 */
export async function encryptFileToChunks(opts: EncryptFileOptions): Promise<ChunkInfo[]> {
  if (opts.chunkSize <= 0) throw new BizhouError("INVALID_ARG", "chunkSize 必须为正");
  const totalChunks = Math.max(1, Math.ceil(opts.fileSize / opts.chunkSize));
  const skip = new Set(opts.skipExisting ?? []);
  const chunks: ChunkInfo[] = [];
  const fh = await open(opts.filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(opts.chunkSize);
    let seq = 0;
    let position = 0;
    let bytesDone = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, opts.chunkSize, position);
      if (bytesRead === 0 && seq > 0) break; // 已到末尾（空文件时 seq===0，仍产出一个空分片）
      const plain = buf.subarray(0, bytesRead);
      const payload = opts.compression === "gzip" ? gzipSync(plain) : plain;
      // 确定性 IV（由 DEK + bundleId + seq 派生）：使续传时"跳过重传的分片"重新加密后
      // 与云端已存密文逐字节一致，manifest 记录的 iv/tag/sha256 因而与已上传密文相符。
      const aad = chunkAad(opts.bundleId, seq);
      const { iv, ciphertext, tag } = aeadEncrypt(
        opts.dek,
        payload,
        aad,
        deriveDeterministicIv(opts.dek, aad),
      );
      if (!skip.has(seq)) {
        await opts.store.putChunk(seq, ciphertext);
      }
      chunks.push({
        seq,
        file: chunkFileName(seq),
        plainSize: bytesRead,
        encSize: ciphertext.length,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        sha256: sha256hex(ciphertext),
      });
      bytesDone += bytesRead;
      position += bytesRead;
      opts.onProgress?.({
        phase: "encrypt",
        seq,
        totalChunks,
        bytesDone,
        bytesTotal: opts.fileSize,
      });
      seq++;
      if (bytesRead < opts.chunkSize) break; // 最后一片（不足整片）
    }
    return chunks;
  } finally {
    await fh.close();
  }
}

export interface DecryptFileOptions {
  readonly chunks: readonly ChunkInfo[];
  readonly dek: Buffer;
  readonly bundleId: string;
  readonly compression: Compression;
  readonly store: BundleStore;
  readonly outPath: string;
  /** 续传：这些 seq 已写入 outPath，跳过下载/解密，仅推进写入偏移。 */
  readonly skip?: readonly number[];
  readonly onProgress?: ProgressCallback;
}

/**
 * 逐片读出、校验、解密、按偏移写入 outPath。任何校验失败即抛错，绝不静默写出损坏数据。
 * skip 内的 seq 视为已在文件中（续传场景），跳过下载/解密，仅推进写入偏移。
 */
export async function decryptChunksToFile(
  opts: DecryptFileOptions,
): Promise<{ bytesWritten: number }> {
  const totalChunks = opts.chunks.length;
  const bytesTotal = opts.chunks.reduce((a, c) => a + c.plainSize, 0);
  const skip = new Set(opts.skip ?? []);
  const resuming = skip.size > 0;
  let bytesDone = 0;
  // 续传写已存在的 .part 用 "r+"（保留已写字节、可越界写）；否则 "w"（新建/截断）。
  const fh = await open(opts.outPath, resuming ? "r+" : "w");
  try {
    let position = 0;
    for (const info of opts.chunks) {
      if (skip.has(info.seq)) {
        position += info.plainSize; // 该片已在文件中，跳过写入、仅推进偏移
        bytesDone += info.plainSize;
        opts.onProgress?.({ phase: "decrypt", seq: info.seq, totalChunks, bytesDone, bytesTotal });
        continue;
      }
      const ct = await opts.store.getChunk(info.seq);
      if (sha256hex(ct) !== info.sha256) {
        throw new BizhouError("CHUNK", `分片 ${info.seq} 密文 sha256 校验失败（数据损坏或被篡改）`);
      }
      const iv = Buffer.from(info.iv, "base64");
      const tag = Buffer.from(info.tag, "base64");
      const payload = aeadDecrypt(opts.dek, iv, ct, tag, chunkAad(opts.bundleId, info.seq));
      const plain = opts.compression === "gzip" ? gunzipSync(payload) : payload;
      if (plain.length !== info.plainSize) {
        throw new BizhouError(
          "CHUNK",
          `分片 ${info.seq} 还原长度 ${plain.length} 与 manifest plainSize ${info.plainSize} 不符`,
        );
      }
      await fh.write(plain, 0, plain.length, position); // 定位写入（支持续传乱序补齐）
      position += plain.length;
      bytesDone += plain.length;
      opts.onProgress?.({ phase: "decrypt", seq: info.seq, totalChunks, bytesDone, bytesTotal });
    }
    await fh.truncate(position); // 收尾：精确文件长度（防旧 .part 更长残留尾字节）
    return { bytesWritten: bytesDone };
  } finally {
    await fh.close();
  }
}
