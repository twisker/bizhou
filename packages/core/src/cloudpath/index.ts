/**
 * 云端路径纯函数（相对云端根 /apps/bizhou/ 的逻辑路径，POSIX 风格，永远用 "/"）。
 * 不碰 IO，供上传/下载映射与目录寻址复用。
 */

/** 规范化：保证前导 "/"、折叠多重 "/"、去掉尾部 "/"（根保留 "/"）。 */
export function normalizeCloudPath(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function joinCloudPath(...parts: string[]): string {
  return normalizeCloudPath(parts.join("/"));
}

export function cloudDirname(p: string): string {
  const n = normalizeCloudPath(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function cloudBasename(p: string): string {
  const n = normalizeCloudPath(p);
  if (n === "/") return "";
  return n.slice(n.lastIndexOf("/") + 1);
}

export function splitCloudPath(p: string): { dir: string; base: string } {
  return { dir: cloudDirname(p), base: cloudBasename(p) };
}
