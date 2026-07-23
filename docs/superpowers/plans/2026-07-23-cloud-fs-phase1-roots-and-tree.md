# 云端文件系统层 · Phase 1（双本地根 + 目录树基础）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为敝帚增加"两个可配置本地根（密钥根/文件根）"与"云端真实目录树基础（Backend 抽象 + `bz mkdir` + `bz ls` 含 `-r`）"，为后续整树备份/还原打底。

**Architecture:** 在现有 `BundleStore`（单 bundle 读写）之上新增**文件系统级 `Backend` 抽象**（mkdir/listDir/bundleStore 工厂），`LocalBackend` 与 `BaiduBackend` 各自实现；云端路径计算收敛到纯函数模块 `cloudpath`；配置模块扩展为解析密钥根/文件根。核心库只发事件、纯函数优先、无 Bun 专有 API。

**Tech Stack:** TypeScript + Bun（兼容 Node LTS）· pnpm monorepo · `bun test` · `node:fs/promises`/`node:os`/`node:path` · Biome lint · tsup 构建。

## Global Constraints

- 核心库 `@bizhou/core` **不得使用 Bun 专有 API**，须在 Node LTS 下等价运行。
- 核心库**只发进度事件、绝不 print**；交互留 CLI 层。
- **密钥/凭证绝不入库、绝不写明文日志**（主密码/恢复密钥/DEK/KEK/token）。
- 解密路径遇 GCM tag 失败/错误主密码**必须报错**，绝不静默返回损坏数据。
- 云端根**固定 `/apps/bizhou/`**（百度沙盒硬约束，常量 `APP_ROOT`）。
- 密钥根默认 `~/.bizhou`（env `BIZHOU_HOME`；`BIZHOU_CONFIG_DIR` 为弃用别名）；文件根默认操作系统下载目录（env `BIZHOU_FILE_ROOT` → `keyRoot/config.json` → 默认）。
- 纯函数（`cloudpath`、config 解析）不碰 IO，env/platform 由调用方注入。
- 每个任务结束跑 `bun test` 全绿 + `pnpm run typecheck` + `npx biome check .` 通过；提交遵循项目提交纪律（每完成一逻辑改动即 commit；`git push` 人工触发）。

---

## 文件结构（Phase 1）

| 文件 | 责任 |
|---|---|
| `packages/core/src/config/index.ts`（改） | 解析密钥根/文件根/下载目录 + `config.json` 路径；`configPaths` 基于密钥根 |
| `packages/core/src/cloudpath/index.ts`（新） | 云端路径纯函数：normalize/split/join/basename/dirname |
| `packages/core/src/backend/index.ts`（新） | `Backend` 接口 + `DirListing` 类型 |
| `packages/core/src/backend/local.ts`（新） | `LocalBackend`（本地目录后端） |
| `packages/core/src/backend/baidu.ts`（新） | `BaiduBackend`（百度后端） |
| `packages/core/src/baidu/client.ts`（改） | 新增 `mkdir(path)` |
| `packages/core/src/store/index.ts`（改） | `LocalBundleStore` 已支持 baseDir，无需改；确认 dir 拼装 |
| `packages/core/src/baidu/store.ts`（改） | `BaiduBundleStore` 增加 `cloudDir` 参数（bundle 所在目录） |
| `packages/core/src/index.ts`（改） | 导出 cloudpath、backend |
| `packages/cli/src/runtime.ts`（改） | 解析 keyRoot/fileRoot；`makeBackend()` |
| `packages/cli/src/commands.ts`（改） | `cmdMkdir`、`cmdLs`（含 `-r`） |
| `packages/cli/src/index.ts`（改） | `mkdir`/`ls` 分发 + `-r` 选项 |
| 各 `test/*.test.ts`（新/改） | 单测与集成测试 |

---

## Task 1: 配置模块 — 双本地根解析

**Files:**
- Modify: `packages/core/src/config/index.ts`
- Test: `packages/core/test/config.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `Env`、`Platform` 类型（已含字符串索引签名）。
- Produces:
  - `resolveKeyRoot(env: Env, platform: Platform): string`
  - `defaultDownloadsDir(env: Env, platform: Platform): string`
  - `resolveFileRoot(env: Env, platform: Platform, configFileRoot?: string): string`
  - `configPaths(env, platform): ConfigPaths`（新增字段 `config: string`；`dir` 现在=密钥根）

- [ ] **Step 1: 写失败测试**

创建 `packages/core/test/config.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  defaultDownloadsDir,
  resolveFileRoot,
  resolveKeyRoot,
  configPaths,
} from "../src/config/index.ts";

describe("密钥根 keyRoot", () => {
  test("BIZHOU_HOME 优先", () => {
    expect(resolveKeyRoot({ BIZHOU_HOME: "/x/y" }, "linux")).toBe("/x/y");
  });
  test("BIZHOU_CONFIG_DIR 弃用别名兜底", () => {
    expect(resolveKeyRoot({ BIZHOU_CONFIG_DIR: "/legacy" }, "linux")).toBe("/legacy");
  });
  test("默认 <home>/.bizhou（三平台一致）", () => {
    expect(resolveKeyRoot({ HOME: "/home/u" }, "linux")).toBe("/home/u/.bizhou");
    expect(resolveKeyRoot({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/.bizhou");
    expect(resolveKeyRoot({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("C:\\Users\\u\\.bizhou");
  });
});

describe("文件根 fileRoot", () => {
  test("默认 = 下载目录", () => {
    expect(defaultDownloadsDir({ HOME: "/home/u" }, "linux")).toBe("/home/u/Downloads");
    expect(defaultDownloadsDir({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe(
      "C:\\Users\\u\\Downloads",
    );
  });
  test("优先级 env > config.json > 默认", () => {
    expect(resolveFileRoot({ BIZHOU_FILE_ROOT: "/env", HOME: "/home/u" }, "linux", "/cfg")).toBe(
      "/env",
    );
    expect(resolveFileRoot({ HOME: "/home/u" }, "linux", "/cfg")).toBe("/cfg");
    expect(resolveFileRoot({ HOME: "/home/u" }, "linux", undefined)).toBe("/home/u/Downloads");
  });
});

describe("configPaths", () => {
  test("基于密钥根，含 config.json", () => {
    const p = configPaths({ BIZHOU_HOME: "/root" }, "linux");
    expect(p.dir).toBe("/root");
    expect(p.vault).toBe("/root/vault.json");
    expect(p.config).toBe("/root/config.json");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/test/config.test.ts`
Expected: FAIL（`resolveKeyRoot`/`defaultDownloadsDir`/`resolveFileRoot` 未导出）

- [ ] **Step 3: 实现**

编辑 `packages/core/src/config/index.ts`，把 `resolveConfigDir` 替换/扩展为下列内容（保留 `Env`/`Platform`/文件名常量）：

```ts
import { join } from "node:path";

// ...（保留现有 Env / Platform / VAULT_FILENAME 等常量）...

export const CONFIG_FILENAME = "config.json";

/** 密钥根：BIZHOU_HOME > BIZHOU_CONFIG_DIR(弃用别名) > <home>/.bizhou。 */
export function resolveKeyRoot(env: Env, platform: Platform): string {
  if (env.BIZHOU_HOME) return env.BIZHOU_HOME;
  if (env.BIZHOU_CONFIG_DIR) return env.BIZHOU_CONFIG_DIR; // 弃用别名
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".bizhou");
}

/** 操作系统当前用户下载目录（默认文件根）。 */
export function defaultDownloadsDir(env: Env, platform: Platform): string {
  const home = platform === "win32" ? (env.USERPROFILE ?? env.HOME ?? ".") : (env.HOME ?? ".");
  return join(home, "Downloads");
}

/** 文件根：BIZHOU_FILE_ROOT > config.json 的 fileRoot > 默认下载目录。 */
export function resolveFileRoot(env: Env, platform: Platform, configFileRoot?: string): string {
  if (env.BIZHOU_FILE_ROOT) return env.BIZHOU_FILE_ROOT;
  if (configFileRoot) return configFileRoot;
  return defaultDownloadsDir(env, platform);
}

export interface ConfigPaths {
  readonly dir: string; // 密钥根
  readonly vault: string;
  readonly secrets: string;
  readonly deviceKey: string;
  readonly config: string;
}

export function configPaths(env: Env, platform: Platform): ConfigPaths {
  const dir = resolveKeyRoot(env, platform);
  return {
    dir,
    vault: join(dir, VAULT_FILENAME),
    secrets: join(dir, SECRETS_FILENAME),
    deviceKey: join(dir, DEVICE_KEY_FILENAME),
    config: join(dir, CONFIG_FILENAME),
  };
}
```

> 保留旧 `resolveConfigDir` 作为 `resolveKeyRoot` 的别名一行导出，避免其他引用断裂：
> `export const resolveConfigDir = resolveKeyRoot;`
> 并在 `Env` 接口补充 `USERPROFILE?: string;`（若尚无——它已有字符串索引签名，编译不报错，但显式声明更清晰）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/test/config.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 类型检查 + lint + 提交**

Run:
```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx biome check --write packages/core/src/config/index.ts packages/core/test/config.test.ts
git add packages/core/src/config/index.ts packages/core/test/config.test.ts
git commit -m "feat(core): 双本地根解析（密钥根 ~/.bizhou + 文件根=下载目录）"
```
Expected: typecheck 无输出（通过）；提交成功（pre-commit 自动 bump patch）。

---

## Task 2: cloudpath — 云端路径纯函数

**Files:**
- Create: `packages/core/src/cloudpath/index.ts`
- Test: `packages/core/test/cloudpath.test.ts`

**Interfaces:**
- Produces:
  - `normalizeCloudPath(p: string): string` — 保证前导 `/`、折叠 `//`、去尾 `/`（根返回 `/`）
  - `joinCloudPath(...parts: string[]): string`
  - `cloudDirname(p: string): string`
  - `cloudBasename(p: string): string`
  - `splitCloudPath(p: string): { dir: string; base: string }`

- [ ] **Step 1: 写失败测试**

`packages/core/test/cloudpath.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  cloudBasename,
  cloudDirname,
  joinCloudPath,
  normalizeCloudPath,
  splitCloudPath,
} from "../src/cloudpath/index.ts";

describe("normalizeCloudPath", () => {
  test("加前导斜杠、折叠、去尾", () => {
    expect(normalizeCloudPath("工作/2026/")).toBe("/工作/2026");
    expect(normalizeCloudPath("/a//b/")).toBe("/a/b");
    expect(normalizeCloudPath("")).toBe("/");
    expect(normalizeCloudPath("/")).toBe("/");
  });
});

describe("join/dirname/basename/split", () => {
  test("join", () => {
    expect(joinCloudPath("/工作", "2026", "报告.pdf")).toBe("/工作/2026/报告.pdf");
    expect(joinCloudPath("/", "a")).toBe("/a");
  });
  test("dirname/basename", () => {
    expect(cloudDirname("/工作/2026/报告.pdf")).toBe("/工作/2026");
    expect(cloudBasename("/工作/2026/报告.pdf")).toBe("报告.pdf");
    expect(cloudDirname("/a")).toBe("/");
    expect(cloudBasename("/")).toBe("");
  });
  test("split", () => {
    expect(splitCloudPath("/工作/报告.pdf")).toEqual({ dir: "/工作", base: "报告.pdf" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/test/cloudpath.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/core/src/cloudpath/index.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/test/cloudpath.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx biome check --write packages/core/src/cloudpath/index.ts packages/core/test/cloudpath.test.ts
git add packages/core/src/cloudpath packages/core/test/cloudpath.test.ts
git commit -m "feat(core): cloudpath 云端路径纯函数（normalize/join/dirname/basename/split）"
```

---

## Task 3: BaiduClient.mkdir + BaiduBundleStore 支持 cloudDir

**Files:**
- Modify: `packages/core/src/baidu/client.ts`（加 `mkdir`）
- Modify: `packages/core/src/baidu/store.ts`（构造函数加 `cloudDir`）
- Test: `packages/core/test/baidu.test.ts`（追加）

**Interfaces:**
- Consumes: 现有 `BaiduClient` / `APP_ROOT` / `HttpClient` / `bundleDirName`。
- Produces:
  - `BaiduClient.mkdir(path: string): Promise<void>`
  - `new BaiduBundleStore(client, bundleId, cloudDir?: string)` — bundle 存于 `APP_ROOT + cloudDir + /<id>.bz/`

- [ ] **Step 1: 写失败测试**（追加到 `packages/core/test/baidu.test.ts` 末尾的 describe 内新增块）

```ts
describe("mkdir + BaiduBundleStore cloudDir", () => {
  test("mkdir 走 create isdir=1，路径正确", async () => {
    let seenBody = "";
    const http: HttpClient = async (url, init) => {
      expect(url).toContain("method=create");
      seenBody = String(init?.body);
      return jsonRes({ errno: 0 });
    };
    await new BaiduClient(CONFIG, "AT", http).mkdir("/apps/bizhou/工作/2026");
    expect(decodeURIComponent(seenBody)).toContain("path=/apps/bizhou/工作/2026");
    expect(decodeURIComponent(seenBody)).toContain("isdir=1");
  });

  test("BaiduBundleStore 带 cloudDir 时 chunk 路径含子目录", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (url, init) => {
      if (url.includes("precreate")) {
        seen.push(decodeURIComponent(String(init?.body).match(/path=([^&]+)/)![1]!));
        return jsonRes({ errno: 0, uploadid: "UP", block_list: [0] });
      }
      if (url.includes("superfile2")) return jsonRes({ md5: "m" });
      if (url.includes("create")) return jsonRes({ errno: 0, fs_id: 1 });
      throw new Error("unexpected");
    };
    const store = new BaiduBundleStore(new BaiduClient(CONFIG, "AT", http), "abcd", "/工作");
    await store.putChunk(0, Buffer.from("x"));
    expect(seen[0]).toBe("/apps/bizhou/工作/abcd.bz/000.part");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/test/baidu.test.ts`
Expected: FAIL（`mkdir` 不存在；`BaiduBundleStore` 第三参未用）

- [ ] **Step 3: 实现**

在 `packages/core/src/baidu/client.ts` 的 `deletePaths` 附近新增：

```ts
  /** 创建目录（xpan create isdir=1，等价 mkdir -p）。 */
  async mkdir(path: string): Promise<void> {
    await this.fileApi("create", {}, form({ path, isdir: "1", rtype: "3" }));
  }
```

在 `packages/core/src/baidu/store.ts` 修改构造函数与 `dir` 计算：

```ts
import { APP_ROOT, type BaiduClient } from "./client.ts";
import { joinCloudPath } from "../cloudpath/index.ts";
// ...
export class BaiduBundleStore implements BundleStore {
  readonly bundleId: string;
  private readonly dir: string;
  private fsidCache: Map<string, number> | undefined;

  constructor(
    private readonly client: BaiduClient,
    bundleId: string,
    cloudDir = "",
  ) {
    this.bundleId = bundleId;
    // /apps/bizhou + <cloudDir> + /<id>.bz
    this.dir = `${APP_ROOT}${joinCloudPath("/", cloudDir, bundleDirName(bundleId))}`;
  }
  // ...其余不变
```

> 说明：`joinCloudPath("/", "", "abcd.bz")` → `/abcd.bz`；`joinCloudPath("/", "/工作", "abcd.bz")` → `/工作/abcd.bz`。拼到 `APP_ROOT` 前面即得完整远端路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/test/baidu.test.ts`
Expected: PASS（含既有用例——既有 `new BaiduBundleStore(client, id)` 因 `cloudDir` 默认 `""` 仍等价根目录）

- [ ] **Step 5: 提交**

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx biome check --write packages/core/src/baidu/client.ts packages/core/src/baidu/store.ts packages/core/test/baidu.test.ts
git add packages/core/src/baidu/client.ts packages/core/src/baidu/store.ts packages/core/test/baidu.test.ts
git commit -m "feat(core): BaiduClient.mkdir + BaiduBundleStore 支持 cloudDir 子目录"
```

---

## Task 4: Backend 抽象 + LocalBackend

**Files:**
- Create: `packages/core/src/backend/index.ts`
- Create: `packages/core/src/backend/local.ts`
- Test: `packages/core/test/backend.local.test.ts`

**Interfaces:**
- Consumes: `BundleStore`、`LocalBundleStore`、`bundleDirName`、`joinCloudPath`。
- Produces:
  - `interface DirListing { dirs: string[]; bundles: { id: string; dir: string }[] }`
  - `interface Backend { mkdir(cloudDir: string): Promise<void>; listDir(cloudDir: string): Promise<DirListing>; bundleStore(bundleId: string, cloudDir: string): BundleStore }`
  - `class LocalBackend implements Backend`（constructor(baseDir: string)）

- [ ] **Step 1: 写失败测试**

`packages/core/test/backend.local.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../src/backend/local.ts";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "bizhou-be-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("LocalBackend", () => {
  test("mkdir 建目录、listDir 分出子目录与 bundle", async () => {
    const be = new LocalBackend(base);
    await be.mkdir("/工作/2026");
    // 在 /工作 下放一个 bundle（用 bundleStore 写 manifest 制造 .bz 目录）
    const store = be.bundleStore("deadbeef", "/工作");
    await store.putManifest("{}");

    const rootList = await be.listDir("/");
    expect(rootList.dirs).toContain("工作");

    const workList = await be.listDir("/工作");
    expect(workList.dirs).toContain("2026");
    expect(workList.bundles).toEqual([{ id: "deadbeef", dir: "/工作" }]);
  });

  test("listDir 不存在的目录 → 空", async () => {
    const be = new LocalBackend(base);
    expect(await be.listDir("/不存在")).toEqual({ dirs: [], bundles: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/test/backend.local.test.ts`
Expected: FAIL（`LocalBackend` 不存在）

- [ ] **Step 3: 实现**

`packages/core/src/backend/index.ts`：

```ts
import type { BundleStore } from "../store/index.ts";

export interface DirListing {
  readonly dirs: string[]; // 子目录名（非 bundle）
  readonly bundles: { id: string; dir: string }[]; // 该目录下的 bundle
}

export interface Backend {
  /** 建目录（mkdir -p 语义）。 */
  mkdir(cloudDir: string): Promise<void>;
  /** 列目录：分出子目录与 bundle。 */
  listDir(cloudDir: string): Promise<DirListing>;
  /** 取某目录下某 bundle 的读写句柄。 */
  bundleStore(bundleId: string, cloudDir: string): BundleStore;
}
```

`packages/core/src/backend/local.ts`：

```ts
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import { normalizeCloudPath } from "../cloudpath/index.ts";
import { LocalBundleStore } from "../store/index.ts";
import type { Backend, DirListing } from "./index.ts";

/** 本地目录后端：baseDir 下用真实子目录还原云端树；bundle 为 <id>.bz 目录。 */
export class LocalBackend implements Backend {
  constructor(private readonly baseDir: string) {}

  private abs(cloudDir: string): string {
    const n = normalizeCloudPath(cloudDir);
    return n === "/" ? this.baseDir : join(this.baseDir, ...n.split("/").filter(Boolean));
  }

  async mkdir(cloudDir: string): Promise<void> {
    await mkdir(this.abs(cloudDir), { recursive: true });
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.abs(cloudDir), { withFileTypes: true });
    } catch {
      return { dirs: [], bundles: [] };
    }
    const dir = normalizeCloudPath(cloudDir);
    const dirs: string[] = [];
    const bundles: { id: string; dir: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.endsWith(BUNDLE_SUFFIX)) {
        bundles.push({ id: e.name.slice(0, -BUNDLE_SUFFIX.length), dir });
      } else {
        dirs.push(e.name);
      }
    }
    return { dirs, bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): LocalBundleStore {
    return new LocalBundleStore(this.abs(cloudDir), bundleId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/test/backend.local.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx biome check --write packages/core/src/backend packages/core/test/backend.local.test.ts
git add packages/core/src/backend packages/core/test/backend.local.test.ts
git commit -m "feat(core): Backend 抽象 + LocalBackend（mkdir/listDir/bundleStore）"
```

---

## Task 5: BaiduBackend + 导出

**Files:**
- Create: `packages/core/src/backend/baidu.ts`
- Modify: `packages/core/src/backend/index.ts`（re-export local/baidu）
- Modify: `packages/core/src/index.ts`（导出 cloudpath、backend）
- Test: `packages/core/test/backend.baidu.test.ts`

**Interfaces:**
- Consumes: `BaiduClient`、`BaiduBundleStore`、`APP_ROOT`、`joinCloudPath`、`BUNDLE_SUFFIX`。
- Produces: `class BaiduBackend implements Backend`（constructor(client: BaiduClient)）

- [ ] **Step 1: 写失败测试**

`packages/core/test/backend.baidu.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { BaiduClient, type HttpClient } from "../src/baidu/index.ts";
import { BaiduBackend } from "../src/backend/baidu.ts";

const CONFIG = { appKey: "K", secretKey: "S" };
function jsonRes(o: unknown) {
  return { ok: true, status: 200, json: async () => o, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
}

describe("BaiduBackend", () => {
  test("mkdir 拼到 APP_ROOT 下", async () => {
    let body = "";
    const http: HttpClient = async (url, init) => {
      body = decodeURIComponent(String(init?.body));
      return jsonRes({ errno: 0 });
    };
    await new BaiduBackend(new BaiduClient(CONFIG, "AT", http)).mkdir("/工作/2026");
    expect(body).toContain("path=/apps/bizhou/工作/2026");
  });

  test("listDir 分出子目录与 bundle", async () => {
    const http: HttpClient = async () =>
      jsonRes({
        errno: 0,
        list: [
          { server_filename: "工作", isdir: 1, path: "/apps/bizhou/工作", fs_id: 1, size: 0 },
          { server_filename: "abcd.bz", isdir: 1, path: "/apps/bizhou/abcd.bz", fs_id: 2, size: 0 },
        ],
      });
    const be = new BaiduBackend(new BaiduClient(CONFIG, "AT", http));
    const r = await be.listDir("/");
    expect(r.dirs).toEqual(["工作"]);
    expect(r.bundles).toEqual([{ id: "abcd", dir: "/" }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/test/backend.baidu.test.ts`
Expected: FAIL（`BaiduBackend` 不存在）

- [ ] **Step 3: 实现**

`packages/core/src/backend/baidu.ts`：

```ts
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import { APP_ROOT, type BaiduClient } from "../baidu/client.ts";
import { BaiduBundleStore } from "../baidu/store.ts";
import { normalizeCloudPath } from "../cloudpath/index.ts";
import type { Backend, DirListing } from "./index.ts";

/** 百度后端：真实目录建在 /apps/bizhou 下。 */
export class BaiduBackend implements Backend {
  constructor(private readonly client: BaiduClient) {}

  private remote(cloudDir: string): string {
    const n = normalizeCloudPath(cloudDir);
    return n === "/" ? APP_ROOT : `${APP_ROOT}${n}`;
  }

  async mkdir(cloudDir: string): Promise<void> {
    await this.client.mkdir(this.remote(cloudDir));
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    const dir = normalizeCloudPath(cloudDir);
    const entries = await this.client.list(this.remote(cloudDir));
    const dirs: string[] = [];
    const bundles: { id: string; dir: string }[] = [];
    for (const e of entries) {
      if (!e.isdir) continue;
      if (e.filename.endsWith(BUNDLE_SUFFIX)) {
        bundles.push({ id: e.filename.slice(0, -BUNDLE_SUFFIX.length), dir });
      } else {
        dirs.push(e.filename);
      }
    }
    return { dirs, bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): BaiduBundleStore {
    return new BaiduBundleStore(this.client, bundleId, cloudDir);
  }
}
```

在 `packages/core/src/backend/index.ts` 末尾追加：

```ts
export { LocalBackend } from "./local.ts";
export { BaiduBackend } from "./baidu.ts";
```

在 `packages/core/src/index.ts` 追加导出：

```ts
export * from "./cloudpath/index.ts";
export * from "./backend/index.ts";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/`
Expected: PASS（全核心库；既有用例不回归）

- [ ] **Step 5: 提交**

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx biome check --write packages/core/src packages/core/test
git add packages/core/src/backend packages/core/src/index.ts packages/core/test/backend.baidu.test.ts
git commit -m "feat(core): BaiduBackend + 导出 cloudpath/backend"
```

---

## Task 6: CLI 运行时 — keyRoot/fileRoot + makeBackend

**Files:**
- Modify: `packages/cli/src/runtime.ts`
- Test: 由 Task 7 的命令测试覆盖（runtime 变更在此任务，测试在下个任务集成验证）

**Interfaces:**
- Consumes: `configPaths`、`resolveFileRoot`、`LocalBackend`、`BaiduBackend`、`baiduClientForCurrent`。
- Produces:
  - `Runtime` 新增字段 `fileRoot: string`
  - `makeBackend(rt: Runtime, localDir: string | undefined): Promise<Backend>`

- [ ] **Step 1: 实现（本任务为装配，随 Task 7 测试）**

在 `packages/cli/src/runtime.ts`：

- import 增补：`import { type Backend, BaiduBackend, LocalBackend, resolveFileRoot } from "@bizhou/core";`
- `Runtime` 接口加：`readonly fileRoot: string;`
- `createRuntime()` 内，解析 fileRoot（读 config.json 的 fileRoot，若存在）：

```ts
  // 读 config.json 里的 fileRoot（若有）
  let configFileRoot: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(paths.config, "utf8")) as { fileRoot?: string };
    configFileRoot = cfg.fileRoot;
  } catch {
    /* 无 config.json，忽略 */
  }
  const fileRoot = resolveFileRoot(process.env, process.platform, configFileRoot);
```

并在返回对象加 `fileRoot,`。（`readFileSync` 已在文件顶部 import；`paths.config` 来自扩展后的 `configPaths`。）

- 文件末尾新增：

```ts
/** 按 --local 选后端：本地目录 or 百度。 */
export async function makeBackend(
  rt: Runtime,
  localDir: string | undefined,
): Promise<Backend> {
  if (localDir) return new LocalBackend(localDir);
  return new BaiduBackend(await baiduClientForCurrent(rt));
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
npx biome check --write packages/cli/src/runtime.ts
git add packages/cli/src/runtime.ts
git commit -m "feat(cli): runtime 解析 fileRoot + makeBackend(本地/百度)"
```

---

## Task 7: CLI 命令 — `bz mkdir` 与 `bz ls`（含 `-r`）

**Files:**
- Modify: `packages/cli/src/commands.ts`（新增 `cmdMkdir`、重写 `cmdLs`）
- Modify: `packages/cli/src/index.ts`（分发 `mkdir`/`ls` + `-r` 选项）
- Test: `packages/cli/test/fs.test.ts`

**Interfaces:**
- Consumes: `makeBackend`、`Runtime`、`readResourceMeta`、`normalizeCloudPath`、`joinCloudPath`、`formatBytes`、`out`/`info`。
- Produces:
  - `cmdMkdir(rt: Runtime, cloudDir: string, opts: CommonOpts): Promise<void>`
  - `cmdLs(rt: Runtime, cloudDir: string | undefined, opts: CommonOpts & { recursive?: boolean }): Promise<void>`

- [ ] **Step 1: 写失败测试**

`packages/cli/test/fs.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdLs, cmdMkdir, cmdPush, createRuntime } from "../src/commands.ts";

let work: string;
let store: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "bizhou-fs-"));
  store = join(work, "store");
  process.env.BIZHOU_HOME = join(work, "home");
  process.env.BIZHOU_MASTER_PASSWORD = "fs-pass";
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.BIZHOU_HOME;
  delete process.env.BIZHOU_MASTER_PASSWORD;
});

describe("mkdir + ls（本地后端）", () => {
  test("mkdir 建目录；push 到子目录；ls 显示子目录与真名；ls -r 递归", async () => {
    const rt = createRuntime();
    await cmdInit(rt, {});
    await cmdMkdir(rt, "/工作/2026", { local: store });

    const f = join(work, "报告.pdf");
    await writeFile(f, Buffer.from("hello"));
    await cmdPush(rt, f, { local: store, to: "/工作/2026", name: "报告.pdf" });

    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      lines.push(String(s));
      return true;
    };
    try {
      await cmdLs(rt, "/工作", { local: store }); // 应列出子目录 2026
      await cmdLs(rt, "/工作/2026", { local: store }); // 应显示 报告.pdf
      await cmdLs(rt, "/", { local: store, recursive: true }); // 递归含 报告.pdf
    } finally {
      process.stdout.write = orig;
    }
    const text = lines.join("");
    expect(text).toContain("2026");
    expect(text).toContain("报告.pdf");
  });
});
```

> 注：本测试依赖 `cmdPush` 支持 `to` 选项（Phase 2 正式实现）。为让 Phase 1 可独立通过，本任务顺带给 `cmdPush` 增加最小 `to` 支持：把 bundle 存到指定 `cloudDir`。见 Step 3 的 `cmdPush` 改动。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/cli/test/fs.test.ts`
Expected: FAIL（`cmdMkdir` 不存在）

- [ ] **Step 3: 实现**

在 `packages/cli/src/commands.ts`：

import 增补：
```ts
import { makeBackend } from "./runtime.ts";
import { normalizeCloudPath } from "@bizhou/core";
```

新增命令：
```ts
export async function cmdMkdir(rt: Runtime, cloudDir: string, opts: CommonOpts): Promise<void> {
  const backend = await makeBackend(rt, opts.local);
  await backend.mkdir(normalizeCloudPath(cloudDir));
  ok(`已创建目录 ${normalizeCloudPath(cloudDir)}`);
}

export async function cmdLs(
  rt: Runtime,
  cloudDir: string | undefined,
  opts: CommonOpts & { recursive?: boolean },
): Promise<void> {
  const mk = await rt.resolveMk(opts);
  const backend = await makeBackend(rt, opts.local);
  const start = normalizeCloudPath(cloudDir ?? "/");

  const walk = async (dir: string, depth: number): Promise<void> => {
    const listing = await backend.listDir(dir);
    for (const d of listing.dirs.sort()) {
      out(`${"  ".repeat(depth)}${c.cyan(d + "/")}`);
      if (opts.recursive) await walk(dir === "/" ? `/${d}` : `${dir}/${d}`, depth + 1);
    }
    for (const b of listing.bundles) {
      try {
        const store = backend.bundleStore(b.id, dir);
        const { meta } = await readResourceMeta(mk, store);
        out(`${"  ".repeat(depth)}${c.dim(b.id.slice(0, 12))}  ${formatBytes(meta.size).padStart(10)}  ${meta.name}`);
      } catch {
        out(`${"  ".repeat(depth)}${c.dim(b.id.slice(0, 12))}  ${c.yellow("(无法读取)")}`);
      }
    }
  };
  await walk(start, 0);
}
```

同时给 `cmdPush` 增加 `to` 选项（把 bundle 放进指定云端目录）。修改 `cmdPush` 的 `opts` 类型加 `to?: string;`，并把 store 构造改为经 backend：

```ts
// cmdPush 内，替换 makeStore 那一行：
  const cloudDir = normalizeCloudPath(opts.to ?? "/");
  const backend = await makeBackend(rt, opts.local);
  if (opts.to) await backend.mkdir(cloudDir); // 目标目录不存在则建
  const store = backend.bundleStore(bundleId, cloudDir);
```

> 移除 `cmdPush` 里旧的 `const store = await makeStore(rt, bundleId, opts.local);`。`makeStore` 暂保留（其他命令仍用，Phase 2 统一迁移）。`CommonOpts` 或 `cmdPush` 局部 opts 增加 `to?: string`。

在 `packages/cli/src/index.ts`：
- `options` 增加 `recursive: { type: "boolean", short: "r" }` 和（若无）`to: { type: "string" }`。
- push 分发处传 `to: values.to as string | undefined`。
- 新增分发：

```ts
    case "mkdir":
      if (!positionals[1]) throw new BizhouError("INVALID_ARG", "用法：bz mkdir <目录>");
      await cmdMkdir(rt, positionals[1], common);
      return 0;
    case "ls":
      await cmdLs(rt, positionals[1], { ...common, recursive: Boolean(values.recursive) });
      return 0;
```

> 若已存在旧 `case "ls"`（M1 的无参 `cmdLs`），替换为上面这版；旧 `cmdLs(rt, opts)` 签名改为 `(rt, cloudDir, opts)`，其调用点仅 index.ts 一处。

并更新 `HELP` 文本：`ls [目录] [-r]`、新增 `mkdir <目录>`、`push ... [--to <云端目录>]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/cli/test/fs.test.ts && bun test`
Expected: PASS（新测试 + 全仓不回归）

- [ ] **Step 5: 类型检查 + lint + 提交**

```bash
pnpm run typecheck
npx biome check --write packages/cli/src packages/cli/test
git add packages/cli/src/commands.ts packages/cli/src/index.ts packages/cli/test/fs.test.ts
git commit -m "feat(cli): bz mkdir + bz ls(-r) + push --to（目录树基础）"
```

---

## Task 8: 登记表同步 + 阶段收尾

**Files:**
- Modify: `.claude/module-spec-registry.md`、`.claude/test-registry.md`、`.claude/current-sprint.md`

- [ ] **Step 1: 更新登记表**

- `module-spec-registry.md`：新增 `cloudpath`、`backend`（Local/Baidu）模块行，状态"阶段1完成"。
- `test-registry.md`：追加 config/cloudpath/backend/CLI-fs 测试项与当前结果。
- `current-sprint.md`：记录 Phase 1 完成、活跃文件清零、改动记录。

- [ ] **Step 2: 全量校验**

Run:
```bash
bun test
pnpm run typecheck
npx biome check .
pnpm run build
```
Expected: 全绿 / 无输出 / 构建 3 份产物。

- [ ] **Step 3: 提交**

```bash
git add .claude
git commit -m "docs: 同步 Phase 1（cloudpath/backend/双根/mkdir/ls）登记表与测试结果"
```

---

## 后续计划（各出独立计划文档，每份产出可工作软件）

- **Phase 2**：上传/下载映射（`push --to` 缺省云端目录计算 + 来源可在文件根外；`pull` 落文件根带入结构；`push -r`/`pull -r` 整树备份/还原；路径→bundle 解析 + 重名歧义）。→ 头条功能"加密文件夹备份/还原"。
- **Phase 3**：`mv`、`cp`(`-r`)、`rename`（bundle=encMeta / 目录=native）。
- **Phase 4**：`rm`→原生回收站（`-r`/`--yes`）；`trash list/restore/rm/clear`（原生，不支持则提示去百度 App）；联网验证回收站开放 API 支持度。

---

## Self-Review（对照 spec）

- **Spec 覆盖**：§2 双本地根 → Task 1、6；§3 云端目录树/常量 → Task 3–5；§4 路径纯函数与寻址基础 → Task 2、7（ls 读 encMeta 显真名）；§7 命令 mkdir/ls(-r) → Task 7；§9 组件（config/cloudpath/backend/runtime/commands）→ 全覆盖。Phase 2–4 的上传映射/mv/cp/rename/trash 明确移交后续计划。
- **占位符扫描**：无 TBD/TODO；每步含真实代码与命令。
- **类型一致性**：`Backend`（mkdir/listDir/bundleStore）、`DirListing`（dirs/bundles{id,dir}）、`BaiduBundleStore(client,id,cloudDir?)`、`resolveKeyRoot/resolveFileRoot/defaultDownloadsDir`、`makeBackend(rt,localDir)`、`cmdLs(rt,cloudDir,opts{recursive})`、`cmdMkdir(rt,cloudDir,opts)` 在各任务间签名一致。
