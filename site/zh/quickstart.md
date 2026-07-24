---
title: 快速开始
parent: 中文文档
nav_order: 2
---

# 快速开始

假设你已[安装](./install.html) `bz` 并备好百度凭证。下面直接开始用。（从源码运行则把 `bz` 换成 `bun packages/cli/src/index.ts`。）

## 1. 初始化（一次性）

```bash
bz init      # 设主密码，生成恢复密钥
```
> **务必把恢复密钥抄下来离线保存**——它是忘记主密码时的唯一兜底。

## 2. 登录百度

```bash
bz login     # 浏览器 OAuth 授权（或 bz login --device 走设备码）
```

## 3. 加密上传 / 还原下载

```bash
# 加密上传（自动分片/加密，带预览）
bz push ./重要资料.zip --preview
#   → 输出资源 ID

# 列出你的资源（显示真名）
bz ls

# 预览（文本/压缩包列表直接打印；图片/视频/PDF 落文件）
bz preview <资源ID>

# 还原下载到文件根（默认系统下载目录）
bz pull <资源ID>
```
云端只存密文、看不到你的文件名与内容；还原出来与原文件**字节级一致**。

## 4. 目录树 / 整树加密备份

```bash
bz mkdir /工作/2026
bz push ./某目录 -r --to /工作/2026     # 整个目录树加密上传（镜像结构）
bz ls /工作 -r                          # 递归列出真名
bz pull /工作/2026 -r                    # 整树还原到文件根
bz mv /工作/2026 /归档                    # 云端也是真实目录，可 mv/cp/rename
bz rm <资源ID>                            # 删到回收站（bz trash 管理）
```

## 5. 幂等、续传、并发（自动，省心）

- **重复 push 同一文件** → 内容去重检测到已存在，**自动跳过**，不产生重复。
- **传到一半断了** → 直接**重跑同一条命令**续传（复用同一密钥与已传分片；下载走临时文件、完成才原子落地并端到端校验）。
- **想更快** → `bz push 大文件 --concurrency 8`（默认 4，范围 1–16）。
- **强制** → `--force` 无视去重/在飞锁。

## 6. 自动备份（可选）

```bash
bz backup add ~/重要目录      # 注册备份任务
bz daemon                     # 前台守护：改文件即备份 + 定时兜底（Ctrl-C 退出）
```
详见 [备份与守护](./guide-backup.html)。

## 7. shell 补全（可选）

```bash
eval "$(bz completion bash)"    # bash（zsh / powershell 见补全教程）
```

下一步 → [核心概念](./concepts.html) · [命令参考](./commands.html)
