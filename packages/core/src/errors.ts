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
