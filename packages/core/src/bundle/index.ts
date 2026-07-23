/**
 * Bundle 与 Manifest：资源的清单结构、加密元数据（encMeta）、序列化与严格校验。
 *
 * 一个"资源"物理上是一个 `<opaque-id>.bz` 文件夹，含：
 *   manifest.json + 000.part/001.part/... （加密分片）+ preview.part（可选）
 *
 * Manifest schema v1（对 PRD §6.2 的落地，配合 vault 的 MK 间接层）：
 * - 明文字段：操作性数据（分片数/大小/iv/tag/sha256、chunkSize、cipher、compression）。
 * - wrappedKey：资源 DEK 被 vault 主密钥 MK 包裹（原 PRD 为被主密码 KEK 直接包裹；
 *   现改由 MK 包裹，KDF/盐移入 vault，故 manifest 不再含 kdf/salt）。
 * - encMeta：原文件名/大小/类型等敏感元数据，用 DEK 加密 → 明文不泄露原文件名。
 */

import { randomBytes } from "node:crypto";
import { openFromBase64, sealToBase64 } from "../crypto/index.ts";
import { ManifestError } from "../errors.ts";

export const MANIFEST_VERSION = 1 as const;
export const BUNDLE_SUFFIX = ".bz";
export const MANIFEST_FILENAME = "manifest.json";
export const PREVIEW_FILENAME = "preview.part";

export type Compression = "none" | "gzip";
export type PreviewKind = "video" | "audio" | "image";

/** 单个加密分片的清单项。 */
export interface ChunkInfo {
  readonly seq: number;
  readonly file: string; // 如 "000.part"
  readonly plainSize: number; // 明文（压缩前）字节数
  readonly encSize: number; // 密文字节数
  readonly iv: string; // base64
  readonly tag: string; // base64
  readonly sha256: string; // 密文 sha256（hex），用于完整性/去重
}

export interface PreviewInfo {
  readonly file: string;
  readonly kind: PreviewKind;
  readonly iv: string;
  readonly tag: string;
}

/** 资源敏感元数据（加密进 encMeta，绝不明文落盘）。 */
export interface ResourceMeta {
  readonly name: string; // 原文件名
  readonly size: number; // 原始明文总字节数
  readonly mtime?: string; // ISO8601，可选
  readonly contentType?: string;
  readonly contentId?: string; // 明文内容指纹（HMAC，仅存加密 encMeta）
}

export interface Manifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly bundleId: string;
  readonly createdAt: string;
  readonly cipher: "AES-256-GCM";
  readonly compression: Compression;
  readonly chunkSize: number;
  readonly wrappedKey: string; // DEK 被 MK 包裹（base64 blob）
  readonly chunks: readonly ChunkInfo[];
  readonly preview?: PreviewInfo;
  readonly encMeta: string; // DEK 加密的 ResourceMeta（base64 blob）
}

/** 生成不透明 bundle ID（不含原文件名）。16 字节随机 → 32 位 hex。 */
export function generateBundleId(): string {
  return randomBytes(16).toString("hex");
}

/** bundle 文件夹名： "<id>.bz"。 */
export function bundleDirName(bundleId: string): string {
  return `${bundleId}${BUNDLE_SUFFIX}`;
}

/** 分片文件名：3 位补零 + ".part"（seq 0 → "000.part"）。 */
export function chunkFileName(seq: number): string {
  return `${String(seq).padStart(3, "0")}.part`;
}

/**
 * 分片加密使用的 AAD：把密文绑定到 (bundleId, seq)，
 * 防止攻击者在云端把分片顺序调换或跨资源移花接木。
 */
export function chunkAad(bundleId: string, seq: number): Buffer {
  return Buffer.from(`${bundleId}:${seq}`, "utf8");
}

/** 用 DEK 加密资源元数据 → encMeta（base64 blob）。 */
export function sealMeta(dek: Buffer, meta: ResourceMeta): string {
  return sealToBase64(dek, Buffer.from(JSON.stringify(meta), "utf8"));
}

/** 用 DEK 解开 encMeta。 */
export function openMeta(dek: Buffer, encMeta: string): ResourceMeta {
  const json = openFromBase64(dek, encMeta).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new ManifestError("encMeta 解密后不是合法 JSON", { cause });
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.name !== "string" || typeof m.size !== "number") {
    throw new ManifestError("encMeta 缺少必需字段 name/size");
  }
  return parsed as ResourceMeta;
}

/** 稳定序列化 manifest（字段固定顺序，2 空格缩进），便于阅读与 diff。 */
export function serializeManifest(m: Manifest): string {
  const ordered: Manifest = {
    version: m.version,
    bundleId: m.bundleId,
    createdAt: m.createdAt,
    cipher: m.cipher,
    compression: m.compression,
    chunkSize: m.chunkSize,
    wrappedKey: m.wrappedKey,
    chunks: m.chunks.map((c) => ({
      seq: c.seq,
      file: c.file,
      plainSize: c.plainSize,
      encSize: c.encSize,
      iv: c.iv,
      tag: c.tag,
      sha256: c.sha256,
    })),
    ...(m.preview ? { preview: m.preview } : {}),
    encMeta: m.encMeta,
  };
  return JSON.stringify(ordered, null, 2);
}

function req(obj: Record<string, unknown>, key: string, type: string): unknown {
  const v = obj[key];
  if (typeof v !== type) {
    throw new ManifestError(`manifest 字段 '${key}' 应为 ${type}，实际 ${typeof v}`);
  }
  return v;
}

function validateChunk(raw: unknown, index: number): ChunkInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestError(`manifest.chunks[${index}] 不是对象`);
  }
  const c = raw as Record<string, unknown>;
  const seq = req(c, "seq", "number") as number;
  const chunk: ChunkInfo = {
    seq,
    file: req(c, "file", "string") as string,
    plainSize: req(c, "plainSize", "number") as number,
    encSize: req(c, "encSize", "number") as number,
    iv: req(c, "iv", "string") as string,
    tag: req(c, "tag", "string") as string,
    sha256: req(c, "sha256", "string") as string,
  };
  if (chunk.seq !== index) {
    throw new ManifestError(
      `manifest.chunks[${index}] 的 seq=${chunk.seq} 与位置不符（应连续从 0）`,
    );
  }
  return chunk;
}

/** 解析并严格校验 manifest JSON。未知/缺失/类型错误一律抛 ManifestError。 */
export function parseManifest(json: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new ManifestError("manifest 不是合法 JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ManifestError("manifest 顶层不是对象");
  }
  const o = parsed as Record<string, unknown>;

  const version = req(o, "version", "number") as number;
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(`不支持的 manifest 版本：${version}（当前仅支持 ${MANIFEST_VERSION}）`);
  }
  const cipher = req(o, "cipher", "string") as string;
  if (cipher !== "AES-256-GCM") {
    throw new ManifestError(`不支持的 cipher：${cipher}`);
  }
  const compression = req(o, "compression", "string") as string;
  if (compression !== "none" && compression !== "gzip") {
    throw new ManifestError(`不支持的 compression：${compression}`);
  }
  if (!Array.isArray(o.chunks)) {
    throw new ManifestError("manifest.chunks 必须是数组");
  }
  const chunks = o.chunks.map(validateChunk);

  let preview: PreviewInfo | undefined;
  if (o.preview !== undefined) {
    if (typeof o.preview !== "object" || o.preview === null) {
      throw new ManifestError("manifest.preview 不是对象");
    }
    const p = o.preview as Record<string, unknown>;
    const kind = req(p, "kind", "string") as string;
    if (kind !== "video" && kind !== "audio" && kind !== "image") {
      throw new ManifestError(`不支持的 preview.kind：${kind}`);
    }
    preview = {
      file: req(p, "file", "string") as string,
      kind,
      iv: req(p, "iv", "string") as string,
      tag: req(p, "tag", "string") as string,
    };
  }

  return {
    version: MANIFEST_VERSION,
    bundleId: req(o, "bundleId", "string") as string,
    createdAt: req(o, "createdAt", "string") as string,
    cipher: "AES-256-GCM",
    compression,
    chunkSize: req(o, "chunkSize", "number") as number,
    wrappedKey: req(o, "wrappedKey", "string") as string,
    chunks,
    ...(preview ? { preview } : {}),
    encMeta: req(o, "encMeta", "string") as string,
  };
}
