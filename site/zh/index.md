---
title: 中文文档
nav_order: 1
has_children: true
permalink: /zh/
---

# 敝帚 Bìzhǒu · 中文文档

**敝帚（Bìzhǒu）** 是开源、跨平台的**客户端加密引擎 + 命令行工具（`bz`）**：把文件托付给百度网盘之前，先在本地端到端加密——云端只存**密文**、读不到你的内容；取回时自动解密还原、**字节级一致**。密钥全程只在你的设备上。

> 「敝帚自珍」——再不起眼的东西，加密后也只有你能读。

## 从这里开始

1. [**安装与前置**](./install.html) —— 装 Bun/pnpm、准备百度凭证、可选预览工具。
2. [**快速开始**](./quickstart.html) —— 5 分钟离线跑通「加密 → 存 → 还原字节一致」，再切到联网。
3. [**核心概念**](./concepts.html) —— 端到端加密、Bundle、双本地根、云端目录树。
4. [**命令参考**](./commands.html) —— 全部 `bz` 命令、参数、示例。

## 进阶教程

- [**备份与守护**](./guide-backup.html) —— `bz backup` 注册任务 + `bz daemon` 自动增量备份。
- [**分享与 shell 补全**](./guide-share-completion.html) —— 分享码 / 7z-AES 导出；bash/zsh/PowerShell 补全。
- [**安全模型**](./security.html) —— 算法、密钥体系、威胁模型、隐私边界。
- [**常见问题 FAQ**](./faq.html)

## 一句话能力清单

加密上传/还原（字节一致）· 并发上传 · 断点续传 · 内容去重 + 在飞锁 · 云端真实目录树（`mkdir/ls/mv/cp/rename`）· 回收站 · `-r` 递归整树 · 自动备份守护 · 多类型预览（文本/PDF/媒体/压缩包列表）· 分享（码 / 7z-AES）· 多账号 · shell 补全。
