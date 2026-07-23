# 云端文件系统层 · Phase 2（上传/下载映射 + `-r` 整树备份/还原）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 把敝帚升级为"加密文件夹备份/还原"：`push` 缺省云端目录按来源相对文件根镜像计算；`pull` 落文件根并带入云端目录结构；`push -r` / `pull -r` 递归整棵目录树。

**Architecture:** 新增一组**纯函数**做本地↔云端路径映射（core/cloudpath），CLI 的 `cmdPush`/`cmdPull` 消费它们；递归用已有 `Backend.listDir` 遍历。核心库只发事件、无 Bun 专有 API。

**Tech Stack:** TypeScript + Bun（兼容 Node LTS）· `bun test` · `node:path`/`node:fs/promises` · Biome · tsup。

## Global Constraints
- `@bizhou/core` 只用 `node:` builtins，NO Bun 专有 API；只发事件、绝不 print；密钥/凭证绝不打印/入库。
- 云端根固定 `/apps/bizhou/`；路径经 `cloudpath` 纯函数（`normalizeCloudPath` 已拒绝 `..` / `\` 穿越）。
- 每任务：`bun test` 全绿 + `pnpm run typecheck` 干净 + `npx biome check .` 无 error；提交遵循纪律（pre-commit 自动 bump；不 push）。
- 已存在可复用：`resolveBundle(rt, idOrPrefix, local) → {id, dir}`（递归解析，T9 已实现）、`makeBackend`、`Backend.{mkdir,listDir,bundleStore}`、`readResourceMeta`、`packResource`/`unpackResource`、`rt.fileRoot`。

---

## 文件结构（Phase 2）
| 文件 | 责任 |
|---|---|
| `packages/core/src/cloudpath/index.ts`（改） | 新增映射纯函数：`defaultUploadCloudDir`、`downloadLocalPath` |
| `packages/cli/src/commands.ts`（改） | `cmdPush` 缺省 `--to` + `-r` 递归；`cmdPull` 落文件根 + `-r` 递归 |
| `packages/cli/src/index.ts`（改） | `push`/`pull` 传 `recursive`；HELP 更新 |
| `packages/core/test/cloudpath.test.ts`（改）、`packages/cli/test/fs.test.ts`（改） | 测试 |

---

## Task 1: cloudpath 映射纯函数

**Files:** Modify `packages/core/src/cloudpath/index.ts`；Test `packages/core/test/cloudpath.test.ts`
**Interfaces produced:**
- `defaultUploadCloudDir(sourceAbs: string, fileRoot: string): string` — 来源在文件根下→返回其**父目录**相对文件根的云端路径；来源在文件根外→返回 `"/"`。
- `downloadLocalPath(fileRoot: string, cloudDir: string, name: string): string` — 落地本地绝对路径 = `fileRoot` + `cloudDir` 各段 + `name`。

- [ ] **Step 1: 失败测试**（追加到 cloudpath.test.ts）
```ts
import { defaultUploadCloudDir, downloadLocalPath } from "../src/cloudpath/index.ts";
import { join, sep } from "node:path";

describe("上传/下载映射", () => {
  const fr = join(sep, "home", "u", "Downloads"); // 跨平台绝对根
  test("defaultUploadCloudDir：来源在文件根下→镜像父目录", () => {
    expect(defaultUploadCloudDir(join(fr, "工作", "报告.pdf"), fr)).toBe("/工作");
    expect(defaultUploadCloudDir(join(fr, "报告.pdf"), fr)).toBe("/"); // 直接在根下
    expect(defaultUploadCloudDir(join(fr, "工作", "2026", "a.bin"), fr)).toBe("/工作/2026");
  });
  test("defaultUploadCloudDir：来源在文件根外→云端根", () => {
    expect(defaultUploadCloudDir(join(sep, "tmp", "foo.pdf"), fr)).toBe("/");
  });
  test("downloadLocalPath：文件根 + 云端相对 + 名", () => {
    expect(downloadLocalPath(fr, "/工作/2026", "报告.pdf")).toBe(
      join(fr, "工作", "2026", "报告.pdf"),
    );
    expect(downloadLocalPath(fr, "/", "a.bin")).toBe(join(fr, "a.bin"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `bun test packages/core/test/cloudpath.test.ts`（函数未定义）

- [ ] **Step 3: 实现**（追加到 cloudpath/index.ts；顶部加 `import { dirname, isAbsolute, join, relative } from "node:path";`）
```ts
/**
 * 上传缺省云端目录：让 sourceAbs 落到相对文件根的镜像位置。
 * 取 sourceAbs 的父目录相对 fileRoot 的路径；在文件根外则回云端根 "/"。
 */
export function defaultUploadCloudDir(sourceAbs: string, fileRoot: string): string {
  const rel = relative(fileRoot, dirname(sourceAbs));
  // 在文件根外：相对路径以 ".." 开头或为绝对路径
  if (rel === "" ) return "/";
  if (isAbsolute(rel) || rel.split(/[/\\]/)[0] === "..") return "/";
  return normalizeCloudPath(rel);
}

/** 下载落地本地绝对路径：fileRoot + 云端目录各段 + 文件名。 */
export function downloadLocalPath(fileRoot: string, cloudDir: string, name: string): string {
  const segs = normalizeCloudPath(cloudDir).split("/").filter(Boolean);
  return join(fileRoot, ...segs, name);
}
```

- [ ] **Step 4: 跑测试确认通过** — `bun test packages/core/test/cloudpath.test.ts`
- [ ] **Step 5: 提交** — typecheck + `biome check --write` + `git commit -m "feat(core): cloudpath 上传/下载映射纯函数（defaultUploadCloudDir/downloadLocalPath）"`

---

## Task 2: `push` 缺省 `--to` + `pull` 落文件根（单文件）

**Files:** Modify `packages/cli/src/commands.ts`；Test `packages/cli/test/fs.test.ts`
**Design:**
- `cmdPush`：当 `--to` 未给时，用 `defaultUploadCloudDir(resolve(filePath), rt.fileRoot)` 作为云端目录（替代现在默认 `/`）。给了 `--to` 则用 `--to`。仍 `backend.mkdir(cloudDir)`（除非是根）。
- `cmdPull`：落地路径改为 `downloadLocalPath(rt.fileRoot, dir, meta.name)`（`dir` 来自 `resolveBundle`）；`--out <子目录>` 若给出，则 base 用 `join(rt.fileRoot, out)`，落地 `join(base, meta.name)`。确保父目录 `mkdir -p`。

- [ ] **Step 1: 失败测试**（追加到 fs.test.ts；注意本地后端下 `rt.fileRoot` 需可控——测试里 `process.env.BIZHOU_FILE_ROOT = <tmp>`）
```ts
test("push 缺省云端目录按文件根镜像；pull 落文件根带入结构", async () => {
  const fr = join(work, "fileroot");
  await mkdir(join(fr, "工作", "2026"), { recursive: true });
  process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    const data = randomBytes(3000);
    const src = join(fr, "工作", "2026", "报告.bin");
    await writeFile(src, data);
    // 不给 --to：应镜像到 /工作/2026
    const id = await cmdPush(rt, src, { local: localStore, name: "报告.bin" });
    // 该 bundle 应在 /工作/2026 下（用 resolveBundle 间接验证：pull 能取回）
    await cmdPull(rt, id, { local: localStore });
    // pull 落文件根镜像位置
    const landed = join(fr, "工作", "2026", "报告.bin");
    expect(sha256(await readFile(landed))).toBe(sha256(data));
  } finally {
    delete process.env.BIZHOU_FILE_ROOT;
  }
});
```

- [ ] **Step 2: 跑失败** — `bun test packages/cli/test/fs.test.ts`（当前 push 默认落根、pull 落 cwd）
- [ ] **Step 3: 实现** — 读当前 `cmdPush`/`cmdPull`，按 Design 改：
  - `cmdPush`：`import { resolve } from "node:path"`（若无）；`const cloudDir = opts.to ? normalizeCloudPath(opts.to) : defaultUploadCloudDir(resolve(filePath), rt.fileRoot);` 之后 `if (cloudDir !== "/") await backend.mkdir(cloudDir);`，`store = backend.bundleStore(bundleId, cloudDir)`。
  - `cmdPull`：`const { id: fullId, dir } = await resolveBundle(...)`；`const outPath = opts.out ? join(rt.fileRoot, opts.out, meta.name) : downloadLocalPath(rt.fileRoot, dir, meta.name);` `await mkdir(dirname(outPath), { recursive: true });` 其余不变。
  - import `defaultUploadCloudDir`, `downloadLocalPath` from `@bizhou/core`。
- [ ] **Step 4: 跑通** — `bun test packages/cli/test/fs.test.ts && bun test`（全绿；既有 cli.test 的 pull `--out` 用法仍可——注意 cli.test 里 pull 用了 `out: outDir`（绝对临时目录），改为落 `join(fileRoot,out,name)` 后路径变了：**同时更新 cli.test.ts 那处断言**：它 `readFile(join(outDir, "私密.bin"))`；现在落 `join(rt.fileRoot, outDir, "私密.bin")`。为兼容，测试里把 `out` 改为相对子目录，或设 `BIZHOU_FILE_ROOT`。实现者需读 cli.test.ts 调整该断言使其通过。）
- [ ] **Step 5: 提交** — `feat(cli): push 缺省云端目录镜像 + pull 落文件根带入结构`

---

## Task 3: `push -r` 递归上传本地目录树

**Files:** Modify `packages/cli/src/commands.ts`、`packages/cli/src/index.ts`；Test `fs.test.ts`
**Design:** `cmdPush` 增 `recursive?: boolean`。当 `-r` 且 `filePath` 是目录：
- 目标云端根 `baseCloud = opts.to ? normalizeCloudPath(opts.to) : defaultUploadCloudDir(resolve(dir)+sep, rt.fileRoot)`（对目录取其**父**镜像）；实际把目录本身作为子目录：`rootCloud = joinCloudPath(baseCloud, basename(dir))`。
- 递归遍历本地目录（`node:fs/promises` `readdir(withFileTypes)`）；对每个文件：cloudDir = `joinCloudPath(rootCloud, <相对子路径的目录部分>)`；`backend.mkdir(cloudDir)`；`packResource` 到 `backend.bundleStore(newId, cloudDir)`。
- 打印每个文件的进度/结果；返回 void（或计数）。非目录 + `-r` → 报错提示。

- [ ] **Step 1: 失败测试**
```ts
test("push -r 递归上传目录树，pull -r 还原字节级一致", async () => {
  const fr = join(work, "fr2"); process.env.BIZHOU_FILE_ROOT = fr;
  try {
    const rt = createRuntime();
    const treeDir = join(work, "tree");
    await mkdir(join(treeDir, "a", "b"), { recursive: true });
    const f1 = randomBytes(1000), f2 = randomBytes(2000);
    await writeFile(join(treeDir, "root.bin"), f1);
    await writeFile(join(treeDir, "a", "b", "deep.bin"), f2);
    await cmdPush(rt, treeDir, { local: localStore, recursive: true, to: "/备份" });
    // 云端应有 /备份/tree/root.bin 与 /备份/tree/a/b/deep.bin（按真名 ls 可见）
    // pull -r 还原整棵树到文件根
    await cmdPull(rt, "/备份/tree", { local: localStore, recursive: true });
    expect(sha256(await readFile(join(fr, "备份", "tree", "root.bin")))).toBe(sha256(f1));
    expect(sha256(await readFile(join(fr, "备份", "tree", "a", "b", "deep.bin")))).toBe(sha256(f2));
  } finally { delete process.env.BIZHOU_FILE_ROOT; }
});
```
> 本测试同时依赖 Task 4 的 `pull -r`。实现 Task 3 时先让"push -r 部分"可跑（可临时拆断言）；Task 4 完成后整测通过。或按需拆成两个 test。

- [ ] **Step 2–5:** RED → 实现 `cmdPush` 的 `-r` 分支 + `index.ts` 传 `recursive: Boolean(values.recursive)` 给 push、HELP 加 `push [-r]` → GREEN（push 部分）→ 提交 `feat(cli): push -r 递归上传本地目录树`。

---

## Task 4: `pull -r` 递归还原云端目录树

**Files:** Modify `packages/cli/src/commands.ts`、`index.ts`；Test `fs.test.ts`
**Design:** `cmdPull` 增 `recursive?: boolean`。当 `-r` 且首参是**云端目录路径**（非 id）：
- 用 `makeBackend` + `backend.listDir` 递归遍历该云端目录子树；对每个 bundle：`store = backend.bundleStore(b.id, b.dir)`；读 meta；`unpackResource` 到 `downloadLocalPath(rt.fileRoot, b.dir, meta.name)`（`mkdir -p` 父目录）。
- 打印进度。空树提示。

- [ ] **Step 1–5:** 失败测试（Task 3 的整测此时应整体通过）→ 实现 `cmdPull` 的 `-r` 分支 + `index.ts` 传 `recursive` 给 pull、HELP 加 `pull [-r]` → 全绿 → 提交 `feat(cli): pull -r 递归还原云端目录树到文件根`。

---

## Task 5: 登记表同步 + Phase 2 收尾
- [ ] 更新 `.claude/{module-spec-registry,test-registry,current-sprint,sprint-plan}.md`：Phase 2 完成、命令表加 `push -r`/`pull -r`/映射、测试计数。
- [ ] 全量验收：`bun test` 全绿、`pnpm run typecheck`、`biome check .`、`pnpm run build`。
- [ ] 提交 `docs: v2-Phase 2 收尾 —— 上传/下载映射 + -r 整树备份还原`。

---

## Self-Review（对照 spec §5/§6/§7）
- §5 上传映射（缺省云端目录 + 来源可在文件根外）→ T1/T2。§6 下载落文件根带入结构 → T1/T2。§7 `push -r`/`pull -r` 整树 → T3/T4。重名歧义 + 路径→bundle 解析已在 v2-P1 T9 完成。
- 类型一致：`defaultUploadCloudDir(sourceAbs,fileRoot)`、`downloadLocalPath(fileRoot,cloudDir,name)`、`cmdPush(...,{recursive,to})`、`cmdPull(...,{recursive,out})` 跨任务一致。
