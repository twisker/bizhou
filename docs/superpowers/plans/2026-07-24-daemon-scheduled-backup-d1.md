# D1 · daemon / 定时备份 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bz backup add/list/rm/run` 注册式加密备份任务 + `bz daemon` 前台守护（启动即扫 + 实时监听防抖 + 定时兜底三触发），全部复用 S1 `pushOneFile`，备份语义永不删云。

**Architecture:** 核心新增 `backup/`（任务模型 + `backups.json` 持久化，纯 IO 可测）。CLI 新增 `watcher.ts`（防抖 + 递归目录发现 + 跨平台 `fs.watch` 薄壳）与 `daemon.ts`（`sweepJob` 引擎 + `SerialJobRunner` 并发护栏 + `cmdBackup` + `cmdDaemon`，单向依赖 `commands.ts` 的 `pushOneFile`/`walkLocalFiles`，无循环）。

**Tech Stack:** TypeScript + Bun 测试；核心库仅 `node:` 内置；CLI 用 `node:fs.watch`（零新依赖）。

**Spec:** `docs/superpowers/specs/2026-07-24-daemon-scheduled-backup-design.md`。**依赖：** S1（`pushOneFile`/`deriveContentKey`/内存夹具）与 v2（`walkLocalFiles`/`defaultUploadCloudDir`/`joinCloudPath`/`normalizeCloudPath`/`makeBackend`）已在 `feature/phase3`（已合并 dev）。

## Global Constraints

- 核心库 `@bizhou/core` **不得用 Bun 专有 API**（Node LTS 等价）；**零新增外部运行时依赖**（`node:` 内置）；核心**只发/返数据、绝不 print**；**绝不读时钟**（`addedAt`/`lastBackupAt`/时间戳由 CLI 注入）。
- daemon 全程**绝不打印**任何密钥/口令/token；`backups.json` 只存路径/时间/id，**无密钥**。
- **备份语义"永不删云"**：daemon/sweep 绝不对云端发删除/回收操作。
- 加密路径完全复用 S1 `pushOneFile`——本子项**不新增任何加密逻辑**。
- **单向依赖**：`daemon.ts` → `commands.ts`（用 `pushOneFile`/`walkLocalFiles`）；`commands.ts` **不得** import `daemon.ts`（`index.ts` 直接分发到 `daemon.ts`）；`watcher.ts` 不依赖 `commands.ts`/`daemon.ts`。
- 版本号由 pre-commit `scripts/bump-version.sh` 自动处理，任务内**不手改** VERSION/package.json 版本。

---

### Task 1: 核心备份任务模型 + backups.json 持久化

**Files:**
- Create: `packages/core/src/backup/index.ts`
- Test: `packages/core/test/backup.test.ts`
- Modify: `packages/core/src/index.ts`（导出 backup）

**Interfaces:**
- Produces（核心不读时钟：`addedAt`/`whenISO` 由调用方注入）：
  - `interface BackupJob { id: string; localDir: string; cloudDir?: string; addedAt: string; lastBackupAt?: string }`
  - `readBackups(keyRoot: string): Promise<BackupJob[]>`（缺失/损坏 → `[]`）
  - `addBackup(keyRoot, input: { localDir: string; cloudDir?: string; addedAt: string }): Promise<BackupJob>`（同 localDir+cloudDir 已存在则返回原任务，幂等不重复）
  - `removeBackup(keyRoot, id: string): Promise<boolean>`
  - `updateLastBackup(keyRoot, id: string, whenISO: string): Promise<void>`

- [ ] **Step 1: 写失败测试** `packages/core/test/backup.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBackup, readBackups, removeBackup, updateLastBackup } from "../src/backup/index.ts";

describe("备份任务模型", () => {
  test("add→list→update→rm 往返；缺失文件读空", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk-"));
    try {
      expect(await readBackups(root)).toEqual([]);

      const j1 = await addBackup(root, { localDir: "/data/a", addedAt: "2026-07-24T00:00:00Z" });
      expect(j1.id).toMatch(/^[0-9a-f]+$/);
      const j2 = await addBackup(root, {
        localDir: "/data/b",
        cloudDir: "/备份/b",
        addedAt: "2026-07-24T01:00:00Z",
      });

      let jobs = await readBackups(root);
      expect(jobs.map((j) => j.localDir).sort()).toEqual(["/data/a", "/data/b"]);
      expect(jobs.find((j) => j.id === j2.id)?.cloudDir).toBe("/备份/b");

      await updateLastBackup(root, j1.id, "2026-07-24T02:00:00Z");
      jobs = await readBackups(root);
      expect(jobs.find((j) => j.id === j1.id)?.lastBackupAt).toBe("2026-07-24T02:00:00Z");

      expect(await removeBackup(root, j1.id)).toBe(true);
      expect(await removeBackup(root, j1.id)).toBe(false);
      jobs = await readBackups(root);
      expect(jobs.map((j) => j.id)).toEqual([j2.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("同 localDir+cloudDir 重复 add → 幂等返回原任务，不新增", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk2-"));
    try {
      const a = await addBackup(root, { localDir: "/x", addedAt: "t1" });
      const b = await addBackup(root, { localDir: "/x", addedAt: "t2" });
      expect(b.id).toBe(a.id);
      expect((await readBackups(root)).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("损坏 backups.json → readBackups 返回 []（不抛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-bk3-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "backups.json"), "{ not json", "utf8");
      expect(await readBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/test/backup.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/core/src/backup/index.ts`

```ts
/**
 * 备份任务模型与持久化：<keyRoot>/backups.json（{version, jobs}）。
 * 纯 IO，不碰网络/加密/时钟（addedAt/lastBackupAt 由 CLI 注入）。只存路径/时间/id，无密钥。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BACKUPS_FILENAME = "backups.json";
const BACKUPS_VERSION = 1;

export interface BackupJob {
  readonly id: string;
  readonly localDir: string;
  readonly cloudDir?: string;
  readonly addedAt: string;
  readonly lastBackupAt?: string;
}

interface BackupsFile {
  version: number;
  jobs: BackupJob[];
}

function backupsPath(keyRoot: string): string {
  return join(keyRoot, BACKUPS_FILENAME);
}

export async function readBackups(keyRoot: string): Promise<BackupJob[]> {
  try {
    const f = JSON.parse(await readFile(backupsPath(keyRoot), "utf8")) as BackupsFile;
    if (!Array.isArray(f.jobs)) return [];
    return f.jobs.filter(
      (j) => typeof j?.id === "string" && typeof j?.localDir === "string",
    );
  } catch {
    return []; // 缺失或损坏
  }
}

async function writeBackups(keyRoot: string, jobs: BackupJob[]): Promise<void> {
  await mkdir(keyRoot, { recursive: true });
  const p = backupsPath(keyRoot);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: BACKUPS_VERSION, jobs }, null, 2), "utf8");
  await rename(tmp, p); // 原子替换
}

export async function addBackup(
  keyRoot: string,
  input: { localDir: string; cloudDir?: string; addedAt: string },
): Promise<BackupJob> {
  const jobs = await readBackups(keyRoot);
  const existing = jobs.find(
    (j) => j.localDir === input.localDir && (j.cloudDir ?? "") === (input.cloudDir ?? ""),
  );
  if (existing) return existing; // 幂等
  const job: BackupJob = {
    id: randomBytes(4).toString("hex"),
    localDir: input.localDir,
    ...(input.cloudDir ? { cloudDir: input.cloudDir } : {}),
    addedAt: input.addedAt,
  };
  await writeBackups(keyRoot, [...jobs, job]);
  return job;
}

export async function removeBackup(keyRoot: string, id: string): Promise<boolean> {
  const jobs = await readBackups(keyRoot);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  await writeBackups(keyRoot, next);
  return true;
}

export async function updateLastBackup(
  keyRoot: string,
  id: string,
  whenISO: string,
): Promise<void> {
  const jobs = await readBackups(keyRoot);
  let changed = false;
  const next = jobs.map((j) => {
    if (j.id === id) {
      changed = true;
      return { ...j, lastBackupAt: whenISO };
    }
    return j;
  });
  if (changed) await writeBackups(keyRoot, next);
}
```

在 `packages/core/src/index.ts` 增 `export * from "./backup/index.ts";`

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/core/test/backup.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/core/src/backup packages/core/test/backup.test.ts packages/core/src/index.ts`

```bash
git add packages/core/src/backup packages/core/test/backup.test.ts packages/core/src/index.ts
git commit -m "feat(core): 备份任务模型 + backups.json 持久化（纯 IO，无密钥）"
```

---

### Task 2: CLI `bz backup add/list/rm`

**Files:**
- Create: `packages/cli/src/daemon.ts`（本任务先放 `cmdBackup`）
- Modify: `packages/cli/src/index.ts`（`backup` 分发 + HELP）
- Test: `packages/cli/test/backup-cmd.test.ts`

**Interfaces:**
- Consumes: `readBackups`/`addBackup`/`removeBackup`（Task 1）。
- Produces: `cmdBackup(rt, sub: string, arg: string | undefined, opts: CommonOpts & { to?: string }): Promise<void>`。

- [ ] **Step 1: 写失败测试** `packages/cli/test/backup-cmd.test.ts`

> 用真实临时 keyRoot 驱动 `cmdBackup`（add/list/rm 只碰 backups.json，不联网、不加密）。构造最小 `rt`：`{ paths: { dir: keyRoot }, fileRoot, now: () => Date.now() }`（`cmdBackup` 只用到这几项）。

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackups } from "@bizhou/core";
import { cmdBackup } from "../src/daemon.ts";

async function makeRt() {
  const keyRoot = await mkdtemp(join(tmpdir(), "bizhou-bkcmd-"));
  const fileRoot = await mkdtemp(join(tmpdir(), "bizhou-fr-"));
  const rt = { paths: { dir: keyRoot }, fileRoot, now: () => 1_753_000_000_000 } as never;
  return { rt, keyRoot, fileRoot };
}

describe("bz backup add/list/rm", () => {
  test("add 已存在目录 → 写入任务；不存在目录 → 抛错", async () => {
    const { rt, keyRoot, fileRoot } = await makeRt();
    try {
      const src = join(fileRoot, "docs");
      await mkdir(src, { recursive: true });
      await cmdBackup(rt, "add", src, {});
      const jobs = await readBackups(keyRoot);
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.localDir).toBe(src);

      await expect(cmdBackup(rt, "add", join(fileRoot, "nope"), {})).rejects.toThrow();
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
      await rm(fileRoot, { recursive: true, force: true });
    }
  });

  test("add --to 记录 cloudDir；rm 删除；list 不抛", async () => {
    const { rt, keyRoot, fileRoot } = await makeRt();
    try {
      const src = join(fileRoot, "d2");
      await mkdir(src, { recursive: true });
      await cmdBackup(rt, "add", src, { to: "/备份/d2" });
      let jobs = await readBackups(keyRoot);
      expect(jobs[0]?.cloudDir).toBe("/备份/d2");

      await cmdBackup(rt, "list", undefined, {}); // 只要求不抛
      await cmdBackup(rt, "rm", jobs[0]?.id, {});
      jobs = await readBackups(keyRoot);
      expect(jobs.length).toBe(0);
    } finally {
      await rm(keyRoot, { recursive: true, force: true });
      await rm(fileRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/backup-cmd.test.ts`
Expected: FAIL（`daemon.ts`/`cmdBackup` 不存在）

- [ ] **Step 3: 实现** `packages/cli/src/daemon.ts`（cmdBackup）

```ts
/**
 * 备份任务命令与 daemon 守护。
 * 单向依赖 commands.ts（pushOneFile/walkLocalFiles）；commands.ts 不得反向 import 本文件。
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  addBackup,
  type BackupJob,
  normalizeCloudPath,
  readBackups,
  removeBackup,
} from "@bizhou/core";
import { BizhouError } from "@bizhou/core";
import { info, ok, out, warn } from "./render.ts"; // 若渲染函数在别处，按实际路径引入
import type { CommonOpts } from "./commands.ts";
import type { Runtime } from "./runtime.ts";

export async function cmdBackup(
  rt: Runtime,
  sub: string,
  arg: string | undefined,
  opts: CommonOpts & { to?: string },
): Promise<void> {
  switch (sub) {
    case "add": {
      if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz backup add <本地目录> [--to <云端目录>]");
      const abs = resolve(arg);
      const st = await stat(abs).catch(() => null);
      if (!st?.isDirectory()) throw new BizhouError("INVALID_ARG", `不是目录：${abs}`);
      const cloudDir = opts.to ? normalizeCloudPath(opts.to) : undefined;
      const job = await addBackup(rt.paths.dir, {
        localDir: abs,
        ...(cloudDir ? { cloudDir } : {}),
        addedAt: new Date(rt.now()).toISOString(),
      });
      ok(`已注册备份任务 ${job.id}：${abs}${cloudDir ? ` → ${cloudDir}` : ""}`);
      return;
    }
    case "list": {
      const jobs = await readBackups(rt.paths.dir);
      if (jobs.length === 0) {
        info("（无备份任务）添加：bz backup add <目录> [--to <云端目录>]");
        return;
      }
      for (const j of jobs) {
        out(
          `${j.id}  ${j.localDir}${j.cloudDir ? ` → ${j.cloudDir}` : "（镜像）"}  上次：${j.lastBackupAt ?? "从未"}`,
        );
      }
      return;
    }
    case "rm": {
      if (!arg) throw new BizhouError("INVALID_ARG", "用法：bz backup rm <id>");
      const removed = await removeBackup(rt.paths.dir, arg);
      if (removed) ok(`已删除备份任务 ${arg}（云端已备份数据不受影响）`);
      else warn(`未找到备份任务：${arg}`);
      return;
    }
    // "run" 在 Task 3 加入
    default:
      throw new BizhouError("INVALID_ARG", `未知子命令：backup ${sub}（用 add/list/rm）`);
  }
}
```

> **实现者注意**：`info`/`ok`/`out`/`warn` 与 `CommonOpts` 的实际导入路径以 `commands.ts` 现有用法为准（先查 `commands.ts` 顶部 import）。`BackupJob` 类型导入用于后续任务。

- [ ] **Step 4: `index.ts` 分发 + HELP**

`packages/cli/src/index.ts` 增 `backup` 分支：解析 `positionals[1]`（子命令）、`positionals[2]`（arg）、`--to`；调 `cmdBackup(rt, sub, arg, { to, ...common })`。HELP 增：

```
备份/守护:
  backup add <本地目录> [--to <云端目录>]   注册加密备份任务
  backup list                              列出备份任务
  backup rm <id>                           删除备份任务（不动云端已备份数据）
```

- [ ] **Step 5: 运行测试 + 回归**

Run: `bun test packages/cli/test/backup-cmd.test.ts && bun test`
Expected: 新测试 PASS；无回归。

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/daemon.ts packages/cli/src/index.ts packages/cli/test/backup-cmd.test.ts`

```bash
git add packages/cli/src/daemon.ts packages/cli/src/index.ts packages/cli/test/backup-cmd.test.ts
git commit -m "feat(cli): bz backup add/list/rm 备份任务命令"
```

---

### Task 3: sweepJob 引擎 + `bz backup run`

**Files:**
- Modify: `packages/cli/src/daemon.ts`（新增 `sweepJob` + `SweepResult`；`cmdBackup` 加 `run` 子命令）
- Modify: `packages/cli/src/index.ts`（HELP 增 `backup run`）
- Test: `packages/cli/test/sweep.test.ts`

**Interfaces:**
- Consumes: `pushOneFile`/`walkLocalFiles`（`commands.ts`，已导出）、`deriveContentKey`/`defaultUploadCloudDir`/`joinCloudPath`/`normalizeCloudPath`（core）、`makeBackend`（runtime）。
- Produces:
  - `interface SweepResult { uploaded: number; skipped: number; failed: number }`
  - `type SweepLogger = (msg: string) => void`
  - `sweepJob(rt, backend, mk, contentKey, job, log): Promise<SweepResult>`

- [ ] **Step 1: 写失败测试** `packages/cli/test/sweep.test.ts`

> 复用 S1 内存夹具（`makeMemoryFixture`）。夹具需暴露：内存 `backend`、固定 `mk`、`countBundles(cloudDir)`。用真实临时目录做 `localDir`。

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveContentKey } from "@bizhou/core";
import { sweepJob } from "../src/daemon.ts";
import { makeMemoryFixture } from "./helpers/memory-fixture.ts";

describe("sweepJob 引擎", () => {
  test("首扫全部 uploaded；再扫全部 skipped；改一个文件→仅它 re-upload；坏文件计 failed 且不中断", async () => {
    const fx = await makeMemoryFixture();
    try {
      const contentKey = deriveContentKey(fx.mk);
      const src = join(fx.tmp, "proj");
      await mkdir(join(src, "sub"), { recursive: true });
      await writeFile(join(src, "a.txt"), "aaa");
      await writeFile(join(src, "sub", "b.txt"), "bbb");
      const job = { id: "j1", localDir: src, addedAt: "t" };

      const r1 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r1.uploaded).toBe(2);
      expect(r1.failed).toBe(0);

      const r2 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r2.skipped).toBe(2);
      expect(r2.uploaded).toBe(0);

      await writeFile(join(src, "a.txt"), "aaa-CHANGED");
      const r3 = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r3.uploaded).toBe(1);
      expect(r3.skipped).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });

  test("单文件 pushOneFile 抛错 → 计入 failed，其余继续，sweep 不整体失败", async () => {
    const fx = await makeMemoryFixture({ failOnFile: "bad.txt" }); // 夹具让含该名的文件上传抛错
    try {
      const contentKey = deriveContentKey(fx.mk);
      const src = join(fx.tmp, "p2");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "good.txt"), "g");
      await writeFile(join(src, "bad.txt"), "b");
      const job = { id: "j2", localDir: src, addedAt: "t" };
      const r = await sweepJob(fx.rt, fx.backend, fx.mk, contentKey, job, () => {});
      expect(r.failed).toBe(1);
      expect(r.uploaded).toBe(1);
    } finally {
      await rm(fx.tmp, { recursive: true, force: true });
    }
  });
});
```

> **实现者注意**：扩展 `memory-fixture.ts`：`makeMemoryFixture` 暴露 `rt`（含 `fileRoot`/`paths.dir`/`now`/`uploadConcurrency`）、`backend`、`mk`、`countBundles`；可选 `failOnFile` 让某文件名的 `putChunk`/`uploadPart` 抛错以驱动 failed 分支。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/sweep.test.ts`
Expected: FAIL（`sweepJob` 不存在）

- [ ] **Step 3: 实现 `sweepJob`（`daemon.ts`）**

在 `daemon.ts` 增导入与实现：

```ts
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  defaultUploadCloudDir,
  deriveContentKey,
  joinCloudPath,
} from "@bizhou/core";
import { pushOneFile, walkLocalFiles } from "./commands.ts";
import type { Backend } from "@bizhou/core";

export interface SweepResult {
  uploaded: number;
  skipped: number;
  failed: number;
}
export type SweepLogger = (msg: string) => void;

/** 对一个备份任务做一次幂等 sweep：walk + 逐文件 pushOneFile（dedup 兜底），单文件错误隔离。 */
export async function sweepJob(
  rt: Runtime,
  backend: Backend,
  mk: Buffer,
  contentKey: Buffer,
  job: BackupJob,
  log: SweepLogger,
): Promise<SweepResult> {
  const localDir = job.localDir;
  const st = await stat(localDir).catch(() => null);
  if (!st?.isDirectory()) {
    log(`跳过（源目录不存在）：${localDir}`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  // 镜像规则与 cmdPushRecursive 逐字一致
  const baseCloud = job.cloudDir
    ? normalizeCloudPath(job.cloudDir)
    : defaultUploadCloudDir(localDir + sep, rt.fileRoot);
  const rootCloud = joinCloudPath(baseCloud, basename(localDir));

  const files = await walkLocalFiles(localDir);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const abs of files) {
    const relDir = dirname(relative(localDir, abs));
    const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
    try {
      const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, {});
      if (r.status === "skipped-dup") skipped++;
      else if (r.status === "locked") {
        /* 正在传，跳过本轮 */
      } else {
        uploaded++;
        log(`已备份：${abs} → ${r.bundleId}`);
      }
    } catch (err) {
      failed++;
      log(`失败（跳过继续）：${abs} — ${(err as Error).message}`);
    }
  }
  return { uploaded, skipped, failed };
}
```

`cmdBackup` 加 `run` 子命令（需解锁 + 建 backend）：

```ts
    case "run": {
      const jobs = await readBackups(rt.paths.dir);
      const targets = arg ? jobs.filter((j) => j.id === arg) : jobs;
      if (targets.length === 0) {
        warn(arg ? `未找到备份任务：${arg}` : "（无备份任务）");
        return;
      }
      const mk = await rt.resolveMk(opts);
      const contentKey = deriveContentKey(mk);
      const backend = await makeBackend(rt, opts.local);
      for (const job of targets) {
        info(`备份 ${job.id}：${job.localDir}`);
        const r = await sweepJob(rt, backend, mk, contentKey, job, (m) => info(m));
        await updateLastBackup(rt.paths.dir, job.id, new Date(rt.now()).toISOString());
        ok(`任务 ${job.id} 完成：上传 ${r.uploaded}，跳过 ${r.skipped}，失败 ${r.failed}`);
      }
      return;
    }
```

（`makeBackend` 从 `./runtime.ts` 引入；`updateLastBackup` 从 `@bizhou/core`。`cmdBackup` 的 `opts` 类型并入 `passwordStdin?`/`local?`——与 `CommonOpts` 一致。）

- [ ] **Step 4: `index.ts` HELP 增 `backup run`**

```
  backup run [<id>]                        手动执行一次备份（省略 id 跑全部）
```

- [ ] **Step 5: 运行测试 + 回归**

Run: `bun test packages/cli/test/sweep.test.ts && bun test`
Expected: 全绿。

- [ ] **Step 6: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/daemon.ts packages/cli/src/index.ts packages/cli/test/sweep.test.ts packages/cli/test/helpers/memory-fixture.ts`

```bash
git add packages/cli/src/daemon.ts packages/cli/src/index.ts packages/cli/test/sweep.test.ts packages/cli/test/helpers/memory-fixture.ts
git commit -m "feat(cli): sweepJob 幂等备份引擎（复用 pushOneFile）+ bz backup run"
```

---

### Task 4: 跨平台递归 watcher + 防抖

**Files:**
- Create: `packages/cli/src/watcher.ts`
- Test: `packages/cli/test/watcher.test.ts`

**Interfaces:**
- Produces:
  - `debounce<T extends unknown[]>(fn: (...a: T) => void, ms: number): { call: (...a: T) => void; cancel: () => void }`
  - `listDirsRecursive(root: string): Promise<string[]>`（含 root 自身的全部子目录）
  - `interface Watcher { stop(): void }`
  - `watchRecursive(dir: string, onChange: () => void, opts: { debounceMs: number; platform?: NodeJS.Platform }): Watcher`

- [ ] **Step 1: 写失败测试** `packages/cli/test/watcher.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debounce, listDirsRecursive } from "../src/watcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watcher 辅助", () => {
  test("debounce：窗口内多次 call → 只触发 1 次，且取最后参数", async () => {
    let calls = 0;
    let last = 0;
    const d = debounce((n: number) => {
      calls++;
      last = n;
    }, 30);
    d.call(1);
    d.call(2);
    d.call(3);
    expect(calls).toBe(0); // 尚未触发
    await sleep(60);
    expect(calls).toBe(1);
    expect(last).toBe(3);
  });

  test("debounce cancel：取消后不触发", async () => {
    let calls = 0;
    const d = debounce(() => {
      calls++;
    }, 20);
    d.call();
    d.cancel();
    await sleep(40);
    expect(calls).toBe(0);
  });

  test("listDirsRecursive：列出根 + 全部子目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bizhou-wr-"));
    try {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await mkdir(join(root, "c"), { recursive: true });
      const dirs = await listDirsRecursive(root);
      expect(dirs).toContain(root);
      expect(dirs).toContain(join(root, "a"));
      expect(dirs).toContain(join(root, "a", "b"));
      expect(dirs).toContain(join(root, "c"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
import { mkdtemp } from "node:fs/promises";
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/watcher.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/cli/src/watcher.ts`

```ts
/**
 * 跨平台递归文件监听 + 防抖。
 * darwin/win32：fs.watch(recursive)；linux：walk 后逐目录 watch（新深层目录尽力而为，定时兜底补漏）。
 * 不依赖 commands.ts/daemon.ts，可独立测试。
 */

import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export function debounce<T extends unknown[]>(
  fn: (...a: T) => void,
  ms: number,
): { call: (...a: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: T | undefined;
  return {
    call: (...args: T) => {
      lastArgs = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (lastArgs) fn(...lastArgs);
      }, ms);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** 列出 root 及其下所有子目录（含 root）。忽略无法读取的目录。 */
export async function listDirsRecursive(root: string): Promise<string[]> {
  const dirs: string[] = [root];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = join(dir, e.name);
        dirs.push(sub);
        await walk(sub);
      }
    }
  };
  await walk(root);
  return dirs;
}

export interface Watcher {
  stop(): void;
}

/** 递归监听 dir；任何变更事件经防抖后调用 onChange。 */
export function watchRecursive(
  dir: string,
  onChange: () => void,
  opts: { debounceMs: number; platform?: NodeJS.Platform },
): Watcher {
  const plat = opts.platform ?? process.platform;
  const d = debounce(onChange, opts.debounceMs);
  const watchers: FSWatcher[] = [];
  const safeWatch = (target: string): void => {
    try {
      watchers.push(watch(target, () => d.call()));
    } catch {
      /* 目标消失/权限：忽略，定时兜底覆盖 */
    }
  };

  if (plat === "darwin" || plat === "win32") {
    safeWatch(dir); // 支持 recursive
    // recursive 选项：
    try {
      watchers.push(watch(dir, { recursive: true }, () => d.call()));
    } catch {
      /* 回退到上面的非递归 + 定时兜底 */
    }
  } else {
    // linux：逐目录监听（当前快照）；新深层目录靠定时兜底 + 事件触发时补扫
    void listDirsRecursive(dir).then((dirs) => {
      for (const sub of dirs) safeWatch(sub);
    });
  }

  return {
    stop() {
      d.cancel();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
```

> **实现者注意**：`fs.watch` 的 OS 事件在单测里时序不稳，故 `watchRecursive` 的 fs 集成**不写自动化断言**（在报告中标注为手动/集成验证）；自动化测试只覆盖纯 `debounce` 与 `listDirsRecursive`。darwin/win32 分支不要重复 watch（保留 `{recursive:true}` 一个即可——实现时择一，勿双监听导致双触发；上面示意保守写法，实现者应只保留 recursive 版本、去掉多余的 `safeWatch(dir)`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/test/watcher.test.ts`
Expected: PASS（debounce ×2 + listDirsRecursive）

- [ ] **Step 5: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/watcher.ts packages/cli/test/watcher.test.ts`

```bash
git add packages/cli/src/watcher.ts packages/cli/test/watcher.test.ts
git commit -m "feat(cli): 跨平台递归 watcher + 防抖（debounce/listDirsRecursive 可测）"
```

---

### Task 5: `bz daemon` 编排 + 每任务串行护栏 + 优雅退出

**Files:**
- Modify: `packages/cli/src/daemon.ts`（`SerialJobRunner` + `cmdDaemon`）
- Modify: `packages/cli/src/runtime.ts`（config `daemonSweepIntervalMs`/`daemonDebounceMs` + `Runtime` 字段）
- Modify: `packages/cli/src/index.ts`（`daemon` 分发 + HELP）
- Test: `packages/cli/test/serial-runner.test.ts`

**Interfaces:**
- Produces:
  - `class SerialJobRunner`：`trigger(): void`（若正跑则置脏，跑完补一轮）；`drain(): Promise<void>`（等当前及补跑结束）。构造入参 `run: () => Promise<void>`。
  - `cmdDaemon(rt, opts): Promise<void>`。
  - `Runtime.daemonSweepIntervalMs: number`（默认 30min，min 5s）、`Runtime.daemonDebounceMs: number`（默认 2s，min 100ms）。

- [ ] **Step 1: 写失败测试** `packages/cli/test/serial-runner.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { SerialJobRunner } from "../src/daemon.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialJobRunner 串行护栏", () => {
  test("跑动中的多次 trigger 只合并成一次补跑（不并发、不丢触发）", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const runner = new SerialJobRunner(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      runs++;
      await sleep(20);
      running--;
    });

    runner.trigger(); // 第 1 次 → 开始跑
    await sleep(5); // 正在跑
    runner.trigger(); // 置脏
    runner.trigger(); // 仍脏（合并）
    runner.trigger();
    await runner.drain();

    expect(maxConcurrent).toBe(1); // 从不并发
    expect(runs).toBe(2); // 第 1 次 + 合并的补跑 1 次（3 次 trigger 合并为 1 补跑）
  });

  test("空闲时 trigger 立即跑一次", async () => {
    let runs = 0;
    const runner = new SerialJobRunner(async () => {
      runs++;
    });
    runner.trigger();
    await runner.drain();
    expect(runs).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/cli/test/serial-runner.test.ts`
Expected: FAIL（`SerialJobRunner` 不存在）

- [ ] **Step 3: 实现 `SerialJobRunner`（`daemon.ts`）**

```ts
/** 串行护栏：同一 runner 的 run() 绝不并发；运行中的多次 trigger 合并为一次补跑。 */
export class SerialJobRunner {
  private running = false;
  private dirty = false;
  private current: Promise<void> = Promise.resolve();
  constructor(private readonly run: () => Promise<void>) {}

  trigger(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    this.current = this.loop();
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.dirty = false;
        await this.run();
      } while (this.dirty);
    } finally {
      this.running = false;
    }
  }

  /** 等当前（及补跑）结束。 */
  async drain(): Promise<void> {
    await this.current;
  }
}
```

- [ ] **Step 4: runtime config 字段**

`packages/cli/src/runtime.ts`：读 config.json 增 `daemonSweepIntervalMs?`/`daemonDebounceMs?`；`Runtime` 增两字段；返回对象里：

```ts
const daemonSweepIntervalMs = Math.max(5_000, cfg?.daemonSweepIntervalMs ?? 30 * 60 * 1000);
const daemonDebounceMs = Math.max(100, cfg?.daemonDebounceMs ?? 2_000);
```

（把这两个并入现有 `JSON.parse(...) as { fileRoot?; uploadConcurrency?; daemonSweepIntervalMs?; daemonDebounceMs? }`。）

- [ ] **Step 5: 实现 `cmdDaemon`（`daemon.ts`）**

```ts
import { watchRecursive } from "./watcher.ts";

export async function cmdDaemon(
  rt: Runtime,
  opts: CommonOpts,
): Promise<void> {
  const jobs = await readBackups(rt.paths.dir);
  if (jobs.length === 0) {
    info("无备份任务，先运行 `bz backup add <目录>`。");
    return;
  }
  const mk = await rt.resolveMk(opts); // 需已解锁或此处提示主密码
  const contentKey = deriveContentKey(mk);
  const backend = await makeBackend(rt, opts.local);

  // 每任务一个串行护栏
  const runners = new Map<string, SerialJobRunner>();
  for (const job of jobs) {
    runners.set(
      job.id,
      new SerialJobRunner(async () => {
        try {
          const r = await sweepJob(rt, backend, mk, contentKey, job, (m) => info(m));
          await updateLastBackup(rt.paths.dir, job.id, new Date(rt.now()).toISOString());
          info(`任务 ${job.id}：上传 ${r.uploaded}，跳过 ${r.skipped}，失败 ${r.failed}`);
        } catch (err) {
          warn(`任务 ${job.id} 本轮出错（下次触发重试）：${(err as Error).message}`);
        }
      }),
    );
  }

  info(`daemon 启动：${jobs.length} 个任务，启动即扫...`);
  for (const job of jobs) runners.get(job.id)?.trigger();
  await Promise.all([...runners.values()].map((r) => r.drain())); // 等启动即扫完

  const watchers = jobs.map((job) =>
    watchRecursive(job.localDir, () => runners.get(job.id)?.trigger(), {
      debounceMs: rt.daemonDebounceMs,
    }),
  );
  const timer = setInterval(() => {
    for (const job of jobs) runners.get(job.id)?.trigger();
  }, rt.daemonSweepIntervalMs);

  info(
    `监听中（防抖 ${rt.daemonDebounceMs}ms，定时兜底 ${Math.round(rt.daemonSweepIntervalMs / 60000)}min）。Ctrl-C 退出。`,
  );

  await new Promise<void>((resolve) => {
    let shutting = false;
    const shutdown = (sig: string): void => {
      if (shutting) return;
      shutting = true;
      info(`收到 ${sig}，停止 daemon（等在飞备份完成）...`);
      for (const w of watchers) w.stop();
      clearInterval(timer);
      void Promise.all([...runners.values()].map((r) => r.drain())).then(() => resolve());
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

  mk.fill(0); // best-effort 抹除内存 MK
  ok("daemon 已退出。");
}
```

- [ ] **Step 6: `index.ts` 分发 + HELP**

`daemon` 分支：`await cmdDaemon(rt, common)`。HELP 增：

```
  daemon                                   前台守护：启动即扫 + 实时监听 + 定时兜底（Ctrl-C 退出）
```

- [ ] **Step 7: 运行测试 + 全量回归 + 构建**

Run: `bun test packages/cli/test/serial-runner.test.ts && bun test && pnpm run build`
Expected: 全绿；构建通过。

- [ ] **Step 8: 类型 + lint + 提交**

Run: `pnpm run typecheck && npx biome check --write packages/cli/src/daemon.ts packages/cli/src/runtime.ts packages/cli/src/index.ts packages/cli/test/serial-runner.test.ts`

```bash
git add packages/cli/src/daemon.ts packages/cli/src/runtime.ts packages/cli/src/index.ts packages/cli/test/serial-runner.test.ts
git commit -m "feat(cli): bz daemon 三触发编排 + SerialJobRunner 串行护栏 + 优雅退出"
```

---

## 收尾（所有任务后）

- [ ] 全量 `bun test` + `pnpm run typecheck` + `npx biome check .` + `pnpm run build` 全绿。
- [ ] **手动/集成验证**（真机）：`bz backup add <某目录>` → `bz daemon` → 改/加文件 → 观察 stderr 打出增量上云、未变文件跳过 → Ctrl-C 观察优雅退出。记录到报告。
- [ ] 更新 `.claude/current-sprint.md`、`.claude/module-spec-registry.md`（backup/watcher/daemon）、`.claude/test-registry.md`（backup/sweep/watcher/serial-runner）、`.claude/sprint-plan.md`（Phase 3 · D1 完成）；`人工TODO事项.md` 增"daemon 真机集成验证"（若未手动跑）。
- [ ] 交由人工按 git flow 处理（本计划不 push）。

## 自审记录

- **Spec 覆盖**：注册任务（T1/T2）/ 幂等引擎（T3）/ 双触发 daemon（T5：启动即扫 + watch(T4) + 定时）/ 备份语义永不删云（sweepJob 只 pushOneFile，无任何删除调用）/ 优雅退出（T5）。
- **类型一致**：`sweepJob`/`SweepResult`/`SerialJobRunner` 跨 T3/T5 一致；`BackupJob` 由 core 定义、CLI 消费；`Runtime` 新增两字段 T5 定义并使用。
- **无循环依赖**：`daemon.ts`→`commands.ts`（pushOneFile/walkLocalFiles）单向；`watcher.ts` 独立；`commands.ts` 不 import `daemon.ts`。
- **无占位符**：各步含完整测试与实现代码；fs.watch 集成明确标注为手动验证、自动化只测纯逻辑。
- **安全**：daemon 不打印密钥；MK 仅驻内存至退出并 best-effort 抹除；backups.json 无密钥；加密全复用 S1；永不删云。
- **测试边界诚实声明**：`watchRecursive` 的 OS 事件与完整 daemon 长跑循环为手动/集成验证；自动化覆盖模型、引擎、防抖、串行护栏等纯逻辑。
