# 测试登记表

本文件记载 **敝帚（Bìzhǒu）** 各模块的测试覆盖情况、测试规范与测试场景。

---

## 通用测试规范

| 规范 | 要求 |
|------|------|
| 单元测试覆盖率 | 核心加密/bundle 逻辑 >= 85%；其他核心逻辑 >= 80% |
| 往返一致性 | 上传→下载→解密→合并**字节级一致**（SHA-256），作为硬性回归测试 |
| 失败路径 | GCM tag 篡改、错误主密码、损坏 manifest、错误恢复密钥必须被检测并报错，绝不静默返回损坏数据 |
| 百度接口测试 | 用 mock / 录制回放，CI 中不依赖真实网盘；真实往返仅在人工 RC 冒烟执行 |
| CLI 测试 | 命令级集成测试（退出码、参数解析、错误消息）；口令输入不回显/不入日志的断言 |
| 大文件测试 | >4GB 分片上传 + 断点续传 + 还原字节一致（可用生成的稀疏/伪随机大文件） |
| 测试运行器 | `bun test`（Bun 优先）；核心库须在 Node LTS 下亦可通过 |
| 性能 | 大文件加密不阻塞主线程（worker_threads）；内存占用与文件大小解耦 |

---

## 核心库测试覆盖（`@bizhou/core`）

| 模块 | 测试文件 | 覆盖率要求 | 当前覆盖率 | 状态 |
|------|---------|-----------|-----------|------|
| crypto（AES-GCM/KDF/信封/恢复密钥） | `packages/core/test/crypto.*` | >= 85% | — | 待开始 |
| bundle（manifest/encMeta/.bz 结构） | `packages/core/test/bundle.*` | >= 85% | — | 待开始 |
| chunker（分片/worker_threads） | `packages/core/test/chunker.*` | >= 80% | — | 待开始 |
| baidu（OAuth/上传/下载/续传，mock） | `packages/core/test/baidu.*` | >= 80% | — | 待开始 |
| preview（预览生成 + 加密） | `packages/core/test/preview.*` | >= 70% | — | 待开始 |
| export（7z-AES 导出） | `packages/core/test/export.*` | >= 70% | — | 待开始 |
| account / keystore | `packages/core/test/account.*` | >= 70% | — | 待开始 |

---

## CLI 测试覆盖（`bz`）

| 模块 | 测试文件 | 覆盖率要求 | 当前覆盖率 | 状态 |
|------|---------|-----------|-----------|------|
| commands（init/unlock/login/push/pull/…） | `packages/cli/test/commands.*` | >= 70% | — | 待开始 |
| prompt（隐藏口令、不回显） | `packages/cli/test/prompt.*` | >= 70% | — | 待开始 |

---

## 基础设施与部署测试覆盖

| 模块 | 测试文件 | 覆盖要求 | 状态 |
|------|---------|---------|------|
| CI 流水线 | `.github/workflows/` | 三平台全流程冒烟（lint+类型+测试+构建） | 待开始 |
| 发版流水线 | `scripts/` | npm publish 与 Homebrew/Scoop manifest 生成冒烟 | 待开始 |
| 版本钩子 | — | commit 后 patch 自动递增验证 | 待开始 |

---

## 测试场景登记

> 待各 Sprint 开发启动后逐步填充。M0 关键场景先行登记：

| Sprint | 目标模块 | 测试描述 | 测试文件 | 结果 |
|--------|---------|---------|---------|------|
| 0 (M0) | baidu | OAuth 拿 token → precreate/superfile2/create 上传 → 下载 → SHA-256 字节一致 | （M0 spike 脚本） | 待执行 |
| 0 (M0) | baidu | 上传"不可识别的加密大文件"确认不被云端限制/封禁 | 人工验证记录 | 待执行 |
| 0 (M0) | baidu | 实测 QPS/配额/限流阈值 | 人工验证记录 | 待执行 |
