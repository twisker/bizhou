# 当前 Sprint

本文档记录当前正在进行的开发：当前 Sprint 的任务、各模块状态、活跃文件清单、近期重要改动记录。

**存档：** 每个 Sprint 结束后，本文件内容完整复制到 `.claude/archive/` 下、以 Sprint 名命名的新 md 文件留存，随后按下一个 Sprint 重新初始化。

**同步：** 任务表中责任人为"人工"的任务，须与根目录 `人工TODO事项.md` 双向同步。

---

## 当前 Sprint：v1.1.0 · 云端保险库与配套能力 ✅ 开发完成（2026-07-25，待人工发版）

**最后更新：** 2026-07-25（T1–T8 全部完成，`bun test` 303 全绿 + 1 skip）

**来源：** 下游 `../bizhouzizhen`（自珍 GUI，闭源）在产品设计定稿时提出的引擎需求清单 **E-1~E-7**
（其 `docs/superpowers/specs/2026-07-25-zizhen-product-design.md` §7 与 `人工TODO事项.md` H-19/H-20）。
按跨仓纪律，一律回本仓改并发版，下游不 fork / 不 vendor / 不 patch。

- **计划：** `docs/superpowers/plans/2026-07-25-v1.1.0-cloud-vault.md`
- **登记：** `.claude/sprint-plan.md` → v1.1.0 章节；技术决策留痕见 `.claude/tech-spec-registry.md` §5.1.2

### 任务状态

| 任务 | 需求 | 说明 | 状态 |
|-----|------|------|------|
| — | E-1 | 修正「换机只需重输主密码」的错误文档 | ✅ `c5f5863` |
| T1 | E-2 前置 | Backend 通用 blob 原语 putBlob/getBlob/removeBlob | ✅ `dde7c20`+`de637d9` |
| T2 | E-3 | scrypt N 2^15 → 2^17（老 vault 向前兼容） | ✅ `ed3b97b` |
| T3 | E-2+E-4 | 云端保险库 `vault/cloud.ts` + 不透明命名 + 保留名过滤 | ✅ `853855f` |
| T4 | E-2 | CLI 接线 + 换机取回 + 存量升级路径 + 强度关卡 | ✅ `e6d96bb` |
| T5 | E-5 | 恢复密钥重导出/轮换 + `bz vault recovery-key` | ✅ `ab9cf49` |
| T6 | E-6 | BaiduBackend `.trash` 回收站 | ✅ `108d6d3` |
| T7 | E-7 | `getQuota` + `bz quota` | ✅ `37f8656` |
| T8 | — | 中英文档 + `.claude/` 登记表 | ✅ `14cc696` + 本次 |

### 待人工触发
| 事项 | 编号 | 状态 |
|------|------|------|
| 发版：`scripts/bump-minor.sh` → 1.1.0 → push → npm publish → tap/bucket → GitHub Release | H-12 | 待执行 |
| 真机联网验证（云端保险库 / 换机 / 改密 / `.trash` / quota；**尤其确认百度是否接受点开头的文件名**） | H-13 | 待验证 |
| 其余存量人工项（daemon 真机、pwsh 补全、pdftoppm 预览） | H-09~H-11 | 待验证 |

### 新增模块/能力
- `@bizhou/core` → `vault/cloud.ts`（云端保险库）、`vault/strength.ts`（主密码强度，CLI 与 GUI 共用）、`vault/index.ts` 增 `wrappedRecoveryByMk` + `exportRecoveryKey`/`rotateRecoveryKey`/`hasExportableRecoveryKey`、`backend/reserved.ts`（保留名集中管理）、`BaiduBackend` 的 `.trash` 回收站、`BaiduClient.getQuota`。
- CLI → `bz vault sync|status|recovery-key [--rotate]`、`bz quota`、`bz init --no-cloud-vault`；`unlock` 支持换机自动取回与存量补传；`passwd`/`recover` 抽出无交互实现体 `changeMasterPassword`/`recoverWithKey`（可测）。

### 活跃文件清单

`packages/core/src/{vault/{index,cloud,strength}.ts, backend/{index,local,baidu,reserved}.ts, baidu/client.ts, crypto/index.ts}`、
`packages/cli/src/{commands,runtime,index,completion}.ts`，
测试 `packages/core/test/{vault-cloud,password-strength,recovery-export,backend.baidu-trash,quota}.test.ts` + `test/helpers/fake-netdisk.ts`、
`packages/cli/test/{vault-cloud-cmd,vault-recovery-cmd}.test.ts`。

### 近期重要改动记录

| 时间 | 改动目的 | 涉及 |
|------|---------|------|
| 2026-07-25 | 云端保险库落地：vault 原样上云（本身即密文信封），`fetchCloudVault` 严格区分「云端没有」与「取不到/损坏」——后者退化成 null 会让老用户在新机被误判为新用户、`bz init` 铸新 MK、云端数据永久锁死 | `packages/core/src/vault/cloud.ts`、`backend/reserved.ts` |
| 2026-07-25 | 主密码强度做成**拦截式**关卡（不是提示）：上云后云服务商持有密文可离线爆破，密码强度成为唯一安全边界；`--no-cloud-vault` 是唯一绕过方式且必须显式告知「换机永久锁死」 | `packages/core/src/vault/strength.ts`、`packages/cli/src/commands.ts` |
| 2026-07-25 | E-5 两条安全约束写进代码：导出恢复密钥强制重输主密码（不认已解锁会话）；`rotateRecoveryKey` 先 `verifyMk`（防用错 MK 覆盖唯一备用入口） | `packages/core/src/vault/index.ts`、`packages/cli/src/commands.ts` |
| 2026-07-25 | E-6 百度回收站改 `.trash` 目录方案（原生 delete 无法管理）；新增带目录语义的假网盘夹具，回收站这类"搬树再搬回"的行为此前无法测 | `packages/core/src/backend/baidu.ts`、`test/helpers/fake-netdisk.ts` |
