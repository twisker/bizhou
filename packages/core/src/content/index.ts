/**
 * 内容身份（contentId）：用于上传/下载幂等去重的"明文内容指纹"。
 *
 * contentId = HMAC-SHA256(contentKey, 明文)，contentKey = HKDF-SHA256(MK, info="bizhou-content-id")。
 * 带密钥 → 不是裸明文哈希，不同账号（不同 MK）对同一明文得到不同指纹，跨账号不可关联；
 * 仅存进加密的 encMeta（绝不明文暴露给云端），故对隐私零泄露。
 * 定义在明文上 → 同文件带不带 --compress 是同一身份。
 */

import { createHmac, hkdfSync } from "node:crypto";
import { open } from "node:fs/promises";

const CONTENT_ID_INFO = Buffer.from("bizhou-content-id", "utf8");
const READ_BUF_BYTES = 1024 * 1024; // 1MB 流式读块

/** 从 MK 派生 32B 内容密钥（域分离，避免与其他用途密钥重用）。 */
export function deriveContentKey(mk: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", mk, Buffer.alloc(0), CONTENT_ID_INFO, 32));
}

/** HMAC-SHA256(contentKey, data) 的 hex 摘要。 */
export function hashPlaintextBuffer(data: Buffer, contentKey: Buffer): string {
  return createHmac("sha256", contentKey).update(data).digest("hex");
}

/** 流式计算整文件的 contentId（内存与文件大小解耦）。 */
export async function hashPlaintextFile(filePath: string, contentKey: Buffer): Promise<string> {
  const hmac = createHmac("sha256", contentKey);
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_BUF_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_BUF_BYTES, position);
      if (bytesRead === 0) break;
      hmac.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hmac.digest("hex");
}
