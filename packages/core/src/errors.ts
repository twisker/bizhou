/**
 * 敝帚核心库统一错误类型。
 * 所有对外抛出的错误都应是 BizhouError 的子类，便于 CLI 层分类映射退出码。
 */

export type BizhouErrorCode =
  | "CRYPTO"
  | "AUTH" // 解密认证失败 / 主密码错误
  | "MANIFEST"
  | "BUNDLE"
  | "CHUNK"
  | "BAIDU"
  | "OAUTH"
  | "ACCOUNT"
  | "VAULT"
  | "IO"
  | "INVALID_ARG";

export class BizhouError extends Error {
  readonly code: BizhouErrorCode;
  constructor(code: BizhouErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = `Bizhou${code}Error`;
  }
}

/** 密码学参数/用法错误（如密钥长度不对）。 */
export class CryptoError extends BizhouError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CRYPTO", message, options);
  }
}

/** 认证失败：GCM tag 校验不通过、主密码/恢复密钥错误。绝不静默，必须抛出。 */
export class AuthError extends BizhouError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("AUTH", message, options);
  }
}

export class ManifestError extends BizhouError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("MANIFEST", message, options);
  }
}

export class VaultError extends BizhouError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("VAULT", message, options);
  }
}

export class InvalidArgError extends BizhouError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("INVALID_ARG", message, options);
  }
}

/**
 * 百度文件 API 返回非 0 errno 时抛出的结构化错误：保留原始 errno（而不是只塞进
 * message 字符串），供调用方按 errno 精确区分"确定不存在"与"请求失败"——
 * 例如 BaiduBackend.findBlobEntry 需要用它来判断 list 失败到底是"目录真的不存在"
 * 还是网络/鉴权/限流等瞬时问题（见该处注释）。
 */
export class BaiduApiError extends BizhouError {
  constructor(
    readonly errno: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super("BAIDU", message, options);
  }
}
