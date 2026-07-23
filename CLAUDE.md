# CLAUDE.md

本文件为 Claude Code 提供 **敝帚（Bìzhǒu）** 项目工作指引。

## 项目简介

**敝帚（Bìzhǒu）** — 开源、跨平台的**客户端加密引擎 + CLI（`bz`）**：上传前本地端到端加密，云端只存密文；取回自动解密还原、字节级一致。

- 项目代号：`bizhou`（CLI 命令 `bz`）
- 版本：见根 `VERSION`（当前 0.2.x；每次 commit 由 `scripts/bump-version.sh` 自动同步 VERSION + 所有 package.json 的 patch）
- 当前阶段：**M0 + M1 已完成**、**v2 云端 FS 层 Phase 1 已完成**（96 测试全绿，opus 整分支评审 Ready to merge）；下一步 **v2-Phase 2**（整树备份/还原）待人工示意开工（见 `.claude/current-sprint.md`）
- 技术栈：TypeScript + Bun（兼容 Node LTS）· pnpm monorepo（`@bizhou/core` + `bz`）· 授权 Apache-2.0

## 核心文档索引

| 文档 | 说明 |
|------|------|
| `design/PRD.md` | 产品需求文档（权威来源） |
| `.claude/COLLABORATION.md` | 协作框架：角色分工、工作步骤、代码提交原则 |
| `.claude/tech-spec-registry.md` | 技术规格：技术栈、算法规范、百度 API 依赖、安全要求 |
| `.claude/arch-spec-registry.md` | 架构规格：分层、环境规划、CI/CD、版本与分发、目录结构 |
| `.claude/sprint-plan.md` | 迭代计划：Sprint 0(M0) + Phase 1(M1) 各阶段任务拆分 |
| `.claude/module-spec-registry.md` | 模块索引：核心库/CLI 各模块的设计文档与源码位置 |
| `.claude/test-registry.md` | 测试登记：各模块测试覆盖与测试场景 |
| `.claude/validation-registry.md` | 验收标准：通用交付标准 + 里程碑 + 模块专项验收 |
| `.claude/current-sprint.md` | 当前 Sprint：实时任务状态、活跃文件、改动记录 |
| `人工TODO事项.md` | 人工事项跟踪：需要人工介入的待办与已完成事项 |

---

## CLAUDE CODING 规范（必须遵守）

### Git 提交纪律（最高优先级）

**每次完成一组有意义的改动后，必须立即 `git add` + `git commit`，不得拖延、不得遗忘、不得等用户提醒。**

1. 新文件或修改，只要有永久保存价值就 `git add` 纳入版本管理。
2. 每完成一个逻辑上完整的改动，立即 `git commit`，附简明提交说明。
3. 多个不相关改动按逻辑分批提交。
4. `git push` **禁止自动执行**，必须由人工手动触发。
5. `.idea/`、`node_modules/`、`__pycache__/`、`.env`、密钥/凭证文件等不纳入版本管理。

### 安全红线（本项目特有，最高优先级）

- **密钥/凭证绝不入库、绝不写明文日志**：主密码、恢复密钥、DEK/KEK、百度 AppKey/SecretKey、OAuth token 一律不得提交、不得 `console.log`、不得进测试快照。
- **加密算法/KDF 参数/密钥包裹与恢复流程的改动**由 AI 自主推进（无需人工逐项确认）：选用业界稳健默认（AES-256-GCM、scrypt/argon2id 合理参数），把算法与参数记入 manifest 与 `tech-spec-registry.md`，并用往返一致性 + 失败路径测试自证正确。重大不可逆决策（如更改已发布 manifest 的密钥包裹格式）在 commit 说明中标注，供人工事后审阅。
- 核心库**只发进度事件、绝不 print**；所有交互（口令输入、确认）留在 CLI 层。
- 任何解密路径遇到 GCM tag 校验失败/错误主密码，必须报错，**绝不静默返回损坏数据**。

### 工作原则

- 严格遵循 `.claude/COLLABORATION.md` 的工作框架。
- 核心库 `@bizhou/core` 不得使用 Bun 专有 API，须在 Node LTS 下等价运行（可嵌入要求）。

### 项目开始时

- 依据 PRD 确定并完善 `.claude/tech-spec-registry.md`、`.claude/sprint-plan.md`、`.claude/module-spec-registry.md`、`.claude/test-registry.md`、`.claude/validation-registry.md`。
- 依工作计划依次开展每个 Sprint。

### 每个 Sprint 开始时

- 依 `.claude/sprint-plan.md` 与当前进度更新 `.claude/current-sprint.md`，直接推进，无需停下等人工确认。
- 检查 `人工TODO事项.md` 中本 Sprint 相关的人工前置事项是否已完成（尤其 M0 的百度凭证 H-01）；若有未完成的人工前置事项，则跳过依赖它的任务、继续可独立推进的部分。

### 每个任务开始时

- 读取 `tech-spec` / `module-spec` / `sprint-plan` / `current-sprint` / `test-registry`，明确技术规格、模块边界、进度、测试要求，直接开始（含加密相关任务，无需人工逐项确认）。

### 每个任务完成前

- 依 `test-registry.md` 逐项测试（含**字节级往返一致性**）。
- 依 `validation-registry.md` 对照自检（含安全红线）。

### 每个任务完成后

- 更新 `current-sprint.md`、`module-spec-registry.md`；把测试结果回写 `test-registry.md`。

### 每个 Sprint 完成后

- 将 `current-sprint.md` 复制到 `.claude/archive/` 存档；更新 `sprint-plan.md`；同步 `人工TODO事项.md`；清空 `current-sprint.md` 内容。

---

## 关键约束

- **零外部二进制依赖（加密路径）**：AES-256-GCM 与 KDF 用运行时内置 `crypto`，保证跨平台一致与可审计。
- **端到端、密钥不出端**：DEK/KEK/主密码/token 全程客户端。
- **百度沙盒**：应用只能操作 `/apps/bizhou/`；单文件上限用 100MB 逻辑分片规避。
- **凭证用户自备**：工具不内嵌任何百度凭证。
- **M0 是全案前提**：必须先实测"云端不因不可识别的加密大文件而限制"，再推进 M1。
- **三平台一致**：Win/macOS/Linux 构建与测试都要过。

## 任务拆分步骤

本项目无前端。对每个阶段的任务，按以下步骤：

1. 先形成设计/接口草案（尤其加密与 manifest schema），由 AI 自主定稿并记入登记表。
2. 分解核心库模块任务（crypto → bundle → chunker → baidu → preview/export/account）。
4. 分解 CLI 命令任务（薄包装、进度渲染、交互）。
5. 分解测试场景与用例（**先写往返一致性与失败路径测试**）。
6. 分解 CI 任务（lint + 类型 + `bun test` + 三平台构建，不触真实网盘）。
7. 分解发布任务（npm publish + Homebrew/Scoop manifest）。
8. 优先级：先测试 → 核心库 → CLI → CI → 发布。
