---
title: 快速开始
parent: 中文文档
nav_order: 2
---

# 快速开始

先离线跑通全链路（无需登录/网络），再切到联网。下面用 `bz` 代表 CLI；从源码运行时把 `bz` 换成 `bun packages/cli/src/index.ts`。

## A. 离线体验（`--local`，5 分钟）

用一个本地目录代替百度网盘，验证「加密 → 存 → 还原**字节级一致**」。

```bash
# 便于演示：把密钥根与主密码放到环境变量（生产别这么用）
export BIZHOU_HOME=/tmp/bz-demo
export BIZHOU_MASTER_PASSWORD=demo-pass
STORE=/tmp/bz-store          # 充当「云端」的本地目录

# 1) 初始化：设主密码、生成恢复密钥（请把恢复密钥抄下来保存）
bz init

# 2) 加密上传一个文件（带压缩与预览）
bz push ./示例.pdf --local $STORE --compress --preview
#   → 输出资源 ID（一串 hex），后续用它取回

# 3) 列出（显示真名，需已解锁）
bz ls --local $STORE

# 4) 预览（文本/压缩包列表直接打印；媒体/PDF 落文件）
bz preview <资源ID> --local $STORE

# 5) 还原下载，并核对字节一致
bz pull <资源ID> --local $STORE --out /tmp/bz-out
diff ./示例.pdf /tmp/bz-out/示例.pdf && echo "字节级一致 ✓"
```

再试试目录树与整树备份：

```bash
bz mkdir /工作/2026 --local $STORE
bz push ./某目录 -r --to /工作/2026 --local $STORE   # 整树加密上传
bz ls /工作 -r --local $STORE                          # 递归列出真名
bz pull /工作/2026 -r --local $STORE                   # 整树还原到文件根
```

## B. 切换到联网（真实百度网盘）

```bash
unset BIZHOU_MASTER_PASSWORD          # 生产用交互式输入更安全
bz login                              # OAuth 登录百度（浏览器授权 / --device 设备码）
# 之后所有命令去掉 --local 即走你的百度网盘：
bz push ./重要资料.zip --preview
bz ls
bz pull <资源ID>
```

## C. 幂等、续传、并发（省心）

- **重复 push 同一文件**：内容去重会检测到目标目录已有相同内容，**自动跳过**，不产生重复。
- **传到一半断了**：直接**重跑同一条命令**即可续传（复用同一密钥与已传分片；下载走临时文件、完成才原子落地）。
- **想更快**：`bz push 大文件 --concurrency 8`（片内 4MB 分片并发，默认 4，范围 1–16）。
- **强制**：`--force` 无视去重/在飞锁强行传。

## D. 自动备份（可选）

```bash
bz backup add ~/重要目录          # 注册一个备份任务
bz daemon                         # 前台守护：启动即扫 + 改文件即备份 + 定时兜底（Ctrl-C 退出）
```
详见 [备份与守护](./guide-backup.html)。

## E. shell 补全（可选）

```bash
# bash：加入 ~/.bashrc
eval "$(bz completion bash)"
# zsh / powershell 见「分享与 shell 补全」教程
```

下一步 → [核心概念](./concepts.html) · [命令参考](./commands.html)
