/**
 * 内存里的"假百度网盘"：实现 BaiduClient 用到的那部分 HTTP 面
 * （list / create(mkdir|文件收尾) / precreate / superfile2 / filemetas + dlink 下载 / filemanager）。
 *
 * 目录与文件分开记账，move/delete 按子树整体搬运——回收站的语义（把一棵目录移进
 * .trash 再移回来）只有在这个层次上才测得出来。
 */

import { ERRNO_PATH_NOT_FOUND, type HttpClient, type HttpResponse } from "../../src/baidu/index.ts";

function jsonRes(obj: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function binRes(buf: Buffer): HttpResponse {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => ab,
  };
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function lastSeg(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export interface FakeNetdisk {
  readonly http: HttpClient;
  readonly files: Map<string, Buffer>;
  readonly dirs: Set<string>;
  mkdirp(path: string): void;
  /** 该路径（含子树）是否存在。 */
  has(path: string): boolean;
}

export function makeFakeNetdisk(): FakeNetdisk {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(["/", "/apps", "/apps/bizhou"]);
  const fsidByPath = new Map<string, number>();
  let nextFsid = 1;

  const fsidOf = (p: string): number => {
    if (!fsidByPath.has(p)) fsidByPath.set(p, nextFsid++);
    return fsidByPath.get(p)!;
  };

  const mkdirp = (path: string): void => {
    const segs = path.split("/").filter(Boolean);
    for (let i = 1; i <= segs.length; i++) dirs.add(`/${segs.slice(0, i).join("/")}`);
  };

  const subtree = (root: string): { dirs: string[]; files: string[] } => ({
    dirs: [...dirs].filter((d) => d === root || d.startsWith(`${root}/`)),
    files: [...files.keys()].filter((f) => f === root || f.startsWith(`${root}/`)),
  });

  const movePath = (src: string, dest: string, newname: string): void => {
    const target = `${dest === "/" ? "" : dest}/${newname}`;
    mkdirp(dest);
    const { dirs: sd, files: sf } = subtree(src);
    for (const d of sd) {
      dirs.delete(d);
      dirs.add(target + d.slice(src.length));
    }
    for (const f of sf) {
      const buf = files.get(f)!;
      files.delete(f);
      files.set(target + f.slice(src.length), buf);
    }
  };

  const removePath = (p: string): void => {
    const { dirs: sd, files: sf } = subtree(p);
    for (const d of sd) dirs.delete(d);
    for (const f of sf) files.delete(f);
  };

  const http: HttpClient = async (url, init) => {
    const body = decodeURIComponent(String(init?.body ?? ""));

    if (url.includes("method=precreate")) {
      return jsonRes({ errno: 0, uploadid: "up-1", block_list: [0] });
    }
    if (url.includes("superfile2")) {
      const path = decodeURIComponent(url.match(/path=([^&]+)/)![1]!);
      const fd = init!.body as FormData;
      const blob = fd.get("file") as Blob;
      const chunk = Buffer.from(await blob.arrayBuffer());
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), chunk]));
      return jsonRes({ md5: "m" });
    }
    if (url.includes("method=create")) {
      const path = body.match(/path=([^&]*)/)![1]!;
      if (/(^|&)isdir=1(&|$)/.test(body)) {
        mkdirp(path);
        return jsonRes({ errno: 0 });
      }
      return jsonRes({ errno: 0, fs_id: fsidOf(path) });
    }
    if (url.includes("method=list")) {
      const dir = decodeURIComponent(url.match(/dir=([^&]+)/)![1]!);
      // 与真实网盘一致：列一个不存在的目录返回 errno=-9，而不是空列表。
      if (!dirs.has(dir)) return jsonRes({ errno: ERRNO_PATH_NOT_FOUND, list: [] });
      const list = [
        ...[...dirs].filter((d) => d !== "/" && parentOf(d) === dir).map((d) => ({ p: d, isdir: 1 })),
        ...[...files.keys()].filter((f) => parentOf(f) === dir).map((f) => ({ p: f, isdir: 0 })),
      ].map(({ p, isdir }) => ({
        fs_id: fsidOf(p),
        path: p,
        server_filename: lastSeg(p),
        size: isdir ? 0 : files.get(p)!.length,
        isdir,
      }));
      return jsonRes({ errno: 0, list });
    }
    if (url.includes("method=filemetas")) {
      const fsids = JSON.parse(decodeURIComponent(url.match(/fsids=([^&]+)/)![1]!)) as number[];
      const list = fsids.map((id) => {
        const path = [...fsidByPath.entries()].find(([, v]) => v === id)?.[0] ?? "";
        return { fs_id: id, dlink: `https://dl.example/${encodeURIComponent(path)}`, filename: path };
      });
      return jsonRes({ errno: 0, list });
    }
    if (url.startsWith("https://dl.example/")) {
      const path = decodeURIComponent(url.slice("https://dl.example/".length).split("?")[0]!);
      const buf = files.get(path);
      if (!buf) return { ...jsonRes({}), ok: false, status: 404 };
      return binRes(buf);
    }
    if (url.includes("method=filemanager")) {
      const filelist = JSON.parse(body.match(/filelist=(\[.*?\])(&|$)/)![1]!) as unknown[];
      if (url.includes("opera=delete")) {
        for (const p of filelist as string[]) removePath(p);
        return jsonRes({ errno: 0 });
      }
      if (url.includes("opera=move")) {
        for (const it of filelist as { path: string; dest: string; newname: string }[]) {
          movePath(it.path, it.dest, it.newname);
        }
        return jsonRes({ errno: 0 });
      }
      if (url.includes("opera=rename")) {
        for (const it of filelist as { path: string; newname: string }[]) {
          movePath(it.path, parentOf(it.path), it.newname);
        }
        return jsonRes({ errno: 0 });
      }
      if (url.includes("opera=copy")) {
        for (const it of filelist as { path: string; dest: string; newname: string }[]) {
          const target = `${it.dest}/${it.newname}`;
          const { dirs: sd, files: sf } = subtree(it.path);
          for (const d of sd) dirs.add(target + d.slice(it.path.length));
          for (const f of sf) files.set(target + f.slice(it.path.length), files.get(f)!);
        }
        return jsonRes({ errno: 0 });
      }
    }
    throw new Error(`fake-netdisk: 未预期的请求 ${url}`);
  };

  return {
    http,
    files,
    dirs,
    mkdirp,
    has: (p) => dirs.has(p) || files.has(p),
  };
}
