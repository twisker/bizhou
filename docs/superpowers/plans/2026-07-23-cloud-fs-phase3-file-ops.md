# 云端文件系统层 · Phase 3（文件操作 mv / cp / rename）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** `bz mv`（移动目录/bundle）、`bz cp`（复制，`-r` 目录）、`bz rename`（bundle 改真名=改 encMeta / 目录 native 改名）。

**Architecture:** `Backend` 增 `move/copy/rename`（目录级，native）；`BaiduClient` 增 filemanager(move/copy/rename)；core 增 `renameResource(mk, store, newName)`（bundle 真名=重写 encMeta）。CLI 命令按"src 先当 bundle(id/prefix) 解析，失败再当目录路径"分派。核心库只发事件、无 Bun 专有 API。

**Tech Stack:** TS + Bun（兼容 Node LTS）· `bun test` · `node:fs/promises`（Local）· Biome。

## Global Constraints
- `@bizhou/core` 只用 `node:` builtins，无 Bun 专有 API；只发事件、绝不 print；密钥/凭证绝不打印/入库；GCM tag/错主密码必报错。
- 云端根固定 `/apps/bizhou/`；路径经 `cloudpath`（`normalizeCloudPath` 拒 `..`/`\`）。
- 每任务：`bun test` 全绿 + typecheck 干净 + biome 无 error；提交遵循纪律（pre-commit 自动 bump；不 push）。
- 已存在可复用：`resolveBundle(rt,idOrPrefix,local)→{id,dir}`、`makeBackend`、`Backend.{mkdir,listDir,bundleStore}`、`BaiduClient.{list,filemetas,deletePaths,uploadPart}`、`BaiduBundleStore`、`bundleDirName`、`normalizeCloudPath`/`joinCloudPath`/`cloudBasename`/`cloudDirname`、`parseManifest`/`serializeManifest`/`sealMeta`/`openMeta`、`unwrapDek`、`APP_ROOT`。

---
## 文件结构
| 文件 | 责任 |
|---|---|
| `packages/core/src/baidu/client.ts`（改） | `filemanager(opera, filelist)` + `move/copy/rename` 封装 |
| `packages/core/src/backend/index.ts`（改） | `Backend` 接口加 `move/copy/rename` |
| `packages/core/src/backend/local.ts`、`baidu.ts`（改） | 两实现 |
| `packages/core/src/resource/index.ts`（改） | `renameResource(mk, store, newName)` |
| `packages/cli/src/commands.ts`、`index.ts`（改） | `cmdMv/cmdCp/cmdRename` + 分发 + HELP |
| 各 test（改/新） | 测试 |

---
## Task 1: BaiduClient filemanager + Backend move/copy/rename

**Interfaces produced:**
- `BaiduClient.move(srcPath, dstDir): Promise<void>`、`copy(srcPath, dstDir): Promise<void>`、`rename(srcPath, newName): Promise<void>`（均走 `xpan/file?method=filemanager&opera=...`，body `async=0&filelist=[{path,dest,newname}]`；move/copy 的 dest=dstDir、newname=basename(srcPath)；rename 的 filelist=[{path,newname}]）。
- `Backend.move(srcCloudPath, dstDir): Promise<void>`、`Backend.copy(srcCloudPath, dstDir): Promise<void>`、`Backend.rename(srcCloudPath, newName): Promise<void>`（目录级；srcCloudPath 是相对云端根的路径，可为目录或 `<id>.bz` 文件夹）。
  - `LocalBackend`：`move`=`fs.rename(abs(src), join(abs(dstDir), cloudBasename(src)))`（先 mkdir dstDir）；`copy`=`fs.cp(abs(src), join(abs(dstDir), cloudBasename(src)), {recursive:true})`；`rename`=`fs.rename(abs(src), join(dirname(abs(src)), newName))`。
  - `BaiduBackend`：转发到 `client.move/copy/rename`，路径前缀 `APP_ROOT`。

- [ ] **Step 1: 失败测试**
  - `packages/core/test/baidu.test.ts` 追加：mock http 断言 `method=filemanager`、`opera=move/copy/rename`、body 含正确 `filelist`（path/dest/newname）。
  - `packages/core/test/backend.local.test.ts` 追加：真实临时目录建 `/a` 目录 + 一个 `x.bz`（putManifest），`move("/a","/b")`→`/b/a` 存在；`copy`→源存留、目标新增；`rename("/b/a","a2")`→`/b/a2`。
- [ ] **Step 2:** RED（方法未定义）
- [ ] **Step 3: 实现**（读现有 client.ts 的 `deletePaths`/`fileApi`/`form` 风格照做；Backend/Local/Baidu 加三方法）
- [ ] **Step 4:** GREEN（`bun test packages/core/`）
- [ ] **Step 5:** typecheck + biome + `git commit -m "feat(core): filemanager move/copy/rename + Backend 目录级 move/copy/rename"`

---
## Task 2: core renameResource（bundle 真名 = 改 encMeta）

**Interface produced:** `renameResource(mk: Buffer, store: BundleStore, newName: string): Promise<void>` —
读 `store.getManifest()`→`parseManifest`；`dek = unwrapDek(mk, manifest.wrappedKey)`；`meta = openMeta(dek, manifest.encMeta)`；`meta2 = {...meta, name: newName}`；`manifest2 = {...manifest, encMeta: sealMeta(dek, meta2)}`；`store.putManifest(serializeManifest(manifest2))`。（随机夹名/分片不动。）

- [ ] Step 1 失败测试（`packages/core/test/resource.test.ts` 追加）：packResource 一个资源（name="旧.bin"）→ `renameResource(mk, store, "新.bin")` → `readResourceMeta` 得 name="新.bin"，且**分片/wrappedKey 不变**、`unpackResource` 仍字节一致。
- [ ] Step 2 RED → Step 3 实现（resource/index.ts 加函数 + 从 index 导出）→ Step 4 GREEN → Step 5 提交 `feat(core): renameResource —— 改 bundle 真名（重写 encMeta，分片不动）`。

---
## Task 3: CLI mv / cp / rename

**Design（分派）：** 各命令先 `try { const b = await resolveBundle(rt, src, local); …bundle 分支… } catch { …把 src 当目录路径… }`（bundle 的云端路径 = `joinCloudPath(b.dir, bundleDirName(b.id))`）。
- `cmdMv(rt, src, dstDir, opts)`：`backend.move(<bundle 或目录 path>, normalizeCloudPath(dstDir))`；先 `backend.mkdir(dstDir)`。
- `cmdCp(rt, src, dstDir, opts{recursive})`：目录需 `-r`，否则报错提示；`backend.copy(...)`。
- `cmdRename(rt, src, newName, opts)`：若 src 解析为 bundle → `renameResource(mk, backend.bundleStore(b.id,b.dir), newName)`；否则 `backend.rename(<目录 path>, newName)`。
- `index.ts`：加 `mv <src> <dstDir>`、`cp <src> <dstDir> [-r]`、`rename <src> <新名>` 三 case + HELP。

- [ ] Step 1 失败测试（`packages/cli/test/fs.test.ts` 追加，本地后端）：
  - push 一个 bundle 到 `/x`；`cmdMv(rt, <id>, "/y")` 后 `ls /y` 含该真名、`ls /x` 不含；
  - `cmdMkdir /d1`；`cmdRename(rt, "/d1", "d2")` 后 `/d2` 存在；
  - `cmdRename(rt, <id>, "改名.bin")` 后 `info`/`ls` 显示新名，`pull` 仍字节一致；
  - `cmdCp(rt, <id>, "/z")` 后源与 `/z` 都有该资源。
- [ ] Step 2 RED → Step 3 实现（读现有 commands.ts/index.ts）→ Step 4 GREEN（全量 `bun test`）→ Step 5 提交 `feat(cli): bz mv / cp / rename（目录与 bundle）`。

---
## Task 4: 登记表同步 + Phase 3 收尾
- [ ] 更新 `.claude/{module-spec,test-registry,current-sprint,sprint-plan}.md`（Phase 3 完成、命令表加 mv/cp/rename、计数）。
- [ ] 全量验收（test/typecheck/biome/build）。
- [ ] 提交 `docs: v2-Phase 3 收尾 —— mv/cp/rename`。

---
## Self-Review（对照 spec §7/§13）
- §13 Phase 3：mv、cp(`-r`)、rename（bundle=encMeta / 目录=native）→ T1/T2/T3 覆盖。
- 类型一致：`Backend.{move,copy,rename}(...)`、`BaiduClient.{move,copy,rename}(...)`、`renameResource(mk,store,newName)`、`cmdMv/cmdCp/cmdRename(rt,src,arg,opts)` 跨任务一致。
- 安全：路径经 normalizeCloudPath；rename bundle 需 MK 解 DEK 才能改 encMeta；不打印密钥。
