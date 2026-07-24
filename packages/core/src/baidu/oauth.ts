/**
 * 百度开放平台 OAuth2。支持两种 CLI 友好流程：
 * - 授权码流（开浏览器 + 本地回调端口）
 * - 设备码流（device code，无浏览器/远程环境）
 *
 * 核心库不读时钟：token 过期时间由调用方（account/CLI）用本地时间戳算。
 * 凭证（appKey/secretKey）由调用方注入，核心库不内嵌任何凭证。
 */

import { BizhouError } from "../errors.ts";

export const OAUTH_BASE = "https://openapi.baidu.com/oauth/2.0";
export const DEFAULT_SCOPE = "basic,netdisk";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface OAuthConfig {
  readonly appKey: string; // client_id
  readonly secretKey: string; // client_secret
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number; // 秒
  readonly scope?: string;
}

export interface DeviceCodeResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly qrcodeUrl?: string;
  readonly interval: number; // 轮询间隔秒
  readonly expiresIn: number;
}

function enc(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function asJson(res: Awaited<ReturnType<FetchLike>>): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.error === "string") {
    throw new BizhouError(
      "OAUTH",
      `百度 OAuth 错误：${data.error} - ${String(data.error_description ?? "")}`,
    );
  }
  return data;
}

function toTokenResponse(d: Record<string, unknown>): TokenResponse {
  if (typeof d.access_token !== "string") {
    throw new BizhouError("OAUTH", "OAuth 响应缺少 access_token");
  }
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    expiresIn: typeof d.expires_in === "number" ? d.expires_in : 0,
    scope: typeof d.scope === "string" ? d.scope : undefined,
  };
}

/** 构造授权页 URL（用户在浏览器打开授权，回调带 code 到 redirectUri）。 */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  redirectUri: string,
  opts: { scope?: string; state?: string } = {},
): string {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.appKey,
    redirect_uri: redirectUri,
    scope: opts.scope ?? DEFAULT_SCOPE,
  };
  if (opts.state) params.state = opts.state;
  return `${OAUTH_BASE}/authorize?${enc(params)}`;
}

/** 用授权码换 token。 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  fetchLike: FetchLike,
): Promise<TokenResponse> {
  const url = `${OAUTH_BASE}/token?${enc({
    grant_type: "authorization_code",
    code,
    client_id: config.appKey,
    client_secret: config.secretKey,
    redirect_uri: redirectUri,
  })}`;
  return toTokenResponse(await asJson(await fetchLike(url)));
}

/** 发起设备码流，返回给用户展示的 user_code 与验证地址。 */
export async function startDeviceFlow(
  config: OAuthConfig,
  fetchLike: FetchLike,
  scope: string = DEFAULT_SCOPE,
): Promise<DeviceCodeResponse> {
  const url = `${OAUTH_BASE}/device/code?${enc({
    response_type: "device_code",
    client_id: config.appKey,
    scope,
  })}`;
  const d = await asJson(await fetchLike(url));
  if (typeof d.device_code !== "string" || typeof d.user_code !== "string") {
    throw new BizhouError("OAUTH", "设备码响应缺少 device_code/user_code");
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUrl: String(d.verification_url ?? "https://openapi.baidu.com/device"),
    qrcodeUrl: typeof d.qrcode_url === "string" ? d.qrcode_url : undefined,
    interval: typeof d.interval === "number" ? d.interval : 5,
    expiresIn: typeof d.expires_in === "number" ? d.expires_in : 0,
  };
}

/**
 * 轮询设备码换 token。返回 null 表示用户尚未授权（应按 interval 继续轮询）。
 */
export async function pollDeviceToken(
  config: OAuthConfig,
  deviceCode: string,
  fetchLike: FetchLike,
): Promise<TokenResponse | null> {
  const url = `${OAUTH_BASE}/token?${enc({
    grant_type: "device_token",
    code: deviceCode,
    client_id: config.appKey,
    client_secret: config.secretKey,
  })}`;
  const raw = (await (await fetchLike(url)).json()) as Record<string, unknown>;
  if (raw.error === "authorization_pending" || raw.error === "slow_down") {
    return null;
  }
  if (typeof raw.error === "string") {
    throw new BizhouError("OAUTH", `设备码授权失败：${raw.error}`);
  }
  return toTokenResponse(raw);
}

/** 用 refresh_token 刷新 access_token。 */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchLike: FetchLike,
): Promise<TokenResponse> {
  const url = `${OAUTH_BASE}/token?${enc({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.appKey,
    client_secret: config.secretKey,
  })}`;
  return toTokenResponse(await asJson(await fetchLike(url)));
}
