/**
 * 云端路径纯函数（相对云端根 /apps/bizhou/ 的逻辑路径，POSIX 风格，永远用 "/"）。
 * 不碰 IO，供上传/下载映射与目录寻址复用。
 */

import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { InvalidArgError } from "../errors.ts";

/**
 * 规范化：保证前导 "/"、折叠多重 "/"、去掉尾部 "/"（根保留 "/"）。
 * 丢弃 "." 段（当前目录，无害）；拒绝 ".." 段（防止路径穿越到根之外）。
 * 同时按 "\\" 切分：防止 Windows 上 `\..\` 段被当作单一不透明段绕过 ".." 检查
 * 而在 LocalBackend 里经 node:path.join 逃逸出 baseDir。
 */
export function normalizeCloudPath(p: string): string {
  const parts = p.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  if (parts.includes("..")) {
    throw new InvalidArgError(`云端路径不允许 '..' 段：${p}`);
  }
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

/**
 * 上传缺省云端目录：让 sourceAbs 落到相对文件根的镜像位置。
 * 取 sourceAbs 的父目录相对 fileRoot 的路径；在文件根外则回云端根 "/"。
 */
export function defaultUploadCloudDir(sourceAbs: string, fileRoot: string): string {
  const rel = relative(fileRoot, dirname(sourceAbs));
  // 在文件根外：相对路径以 ".." 开头或为绝对路径
  if (rel === "") return "/";
  if (isAbsolute(rel) || rel.split(/[/\\]/)[0] === "..") return "/";
  return normalizeCloudPath(rel);
}

/**
 * 下载落地本地绝对路径：fileRoot + 云端目录各段 + 文件名。
 * name 经 basename 净化：encMeta 里的原文件名在分享他人 bundle 时可能被构造为
 * 含 `../` 或路径分隔符的串，basename 只取最后一段，杜绝 pull 时逃逸文件根。
 */
export function downloadLocalPath(fileRoot: string, cloudDir: string, name: string): string {
  const segs = normalizeCloudPath(cloudDir).split("/").filter(Boolean);
  // 同时按正反斜杠取末段，防跨平台分隔符注入
  const safeName = basename(name.replace(/\\/g, "/"));
  return join(fileRoot, ...segs, safeName);
}
