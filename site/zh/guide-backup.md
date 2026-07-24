---
title: 教程：备份与守护
parent: 中文文档
nav_order: 5
---

# 教程：备份与守护

把「加密上传」升级为「无人值守的自动加密备份」——注册目录，之后改动自动加密上云。

## 心智模型

- 一个**备份任务** = `本地目录 → 云端目录`。
- 唯一操作是**幂等 sweep**：遍历本地目录，逐文件调用与 `push` 相同的内核——**没变的文件秒跳过，改了的自动增量上传**（复用去重/续传/在飞锁）。
- **三种触发**都只是「跑一次 sweep」：启动即扫、文件变更（防抖）、定时兜底。
- **备份语义 = 永不删云**：你在本地删了文件，云端备份**保留不动**（防误删，仍可取回）；要清云端用 `bz rm` / `bz trash`。

## 1. 注册备份任务

```bash
bz backup add ~/Documents/重要资料
bz backup add ~/Code/myproject --to /代码备份/myproject   # 显式云端落点
bz backup list
#  a1b2c3d4  /Users/me/Documents/重要资料  （镜像）  上次：从未
#  e5f6a7b8  /Users/me/Code/myproject     → /代码备份/myproject  上次：从未
```

## 2. 手动跑一次

```bash
bz backup run              # 跑全部任务
bz backup run a1b2c3d4     # 只跑某个任务
#  任务 a1b2c3d4 完成：上传 128，跳过 0，失败 0
```
再跑一次会看到「跳过 128」——幂等去重生效，未变文件零上传。

## 3. 前台守护（自动）

```bash
bz daemon
#  daemon 启动：2 个任务，启动即扫...
#  任务 a1b2c3d4：上传 128，跳过 0，失败 0
#  监听中（防抖 2000ms，定时兜底 30min）。Ctrl-C 退出。
```

此后：
- **改/加文件** → 防抖 2s → 自动增量备份该任务。
- **每 30 分钟** → 全量兜底 sweep（补掉可能漏掉的事件）。
- **`Ctrl-C` / `SIGTERM`** → 优雅退出：停监听、等在飞备份跑完再退，内存主密钥抹除。

> daemon 需已 `bz login` + 已解锁（或启动时提示主密码）。它把主密钥驻留内存直至退出——这是无人值守备份的固有前提。

## 4. 后台化（自行）

`bz daemon` 是**前台**进程。要长期后台运行，用你系统的常规方式：

```bash
# 简单
nohup bz daemon > ~/.bizhou/daemon.log 2>&1 &

# 或交给 systemd（Linux）/ launchd（macOS）/ 计划任务（Windows）管理
```

## 5. 可配置项（`config.json`，密钥根下）

| 键 | 默认 | 说明 |
|---|---|---|
| `daemonDebounceMs` | 2000 | 文件变更防抖窗口（毫秒） |
| `daemonSweepIntervalMs` | 1800000 | 定时兜底间隔（毫秒，默认 30min） |
| `uploadConcurrency` | 4 | 片内 4MB 分片并发（也可 push `--concurrency`） |
| `fileRoot` | 系统下载目录 | 文件根（也可 `BIZHOU_FILE_ROOT`） |

## 跨平台监听说明

macOS / Windows 用原生递归监听；Linux 逐目录监听 + **定时兜底**补掉新建深层目录等遗漏——所以定时 sweep 是可靠性主干，即便实时事件漏了也不会丢备份。
