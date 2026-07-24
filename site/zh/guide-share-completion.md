---
title: 教程：分享与 shell 补全
parent: 中文文档
nav_order: 6
---

# 教程：分享与 shell 补全

## 一、分享资源

### 分享码（`--code`）
导出某资源的 **DEK 分享码**——持码者可解密该资源（其余资源仍安全）。

```bash
bz share <资源ID> --code
#  → 输出一串分享码
```

### 7z-AES 单包（`--7z`）
导出一个 **7z-AES（含头部加密）** 单包，任何人用 7-Zip / Keka / p7zip + 密码即可解压，**无需安装敝帚**——适合发给不用本工具的人。

```bash
bz share <资源ID> --7z --out ~/分享
#  → 生成 <名>.7z（需本机有 7z 二进制）
```

> 分享意味着把明文交给对方——请只分享给你信任的人。

---

## 二、shell 补全

`bz completion <shell>` 输出补全脚本。补全包括：**命令 / 子命令 / flag** 静态补全，以及 **backup 任务 id / 账号名 / shell 名**的本地动态补全（这些**只读本地、绝不联网、绝不弹密码**）。文件/目录参数走各 shell 的**原生文件补全**。

### bash

```bash
# 当前会话
eval "$(bz completion bash)"
# 持久化：加入 ~/.bashrc
echo 'eval "$(bz completion bash)"' >> ~/.bashrc
```
需已安装 `bash-completion`（提供 `_filedir` 等）。

### zsh

```zsh
# 持久化：写入 fpath 下的 _bz
bz completion zsh > "${fpath[1]}/_bz"
# 或当前会话
eval "$(bz completion zsh)"
autoload -U compinit && compinit
```

### PowerShell

```powershell
# 当前会话
bz completion powershell | Out-String | Invoke-Expression
# 持久化：写入 $PROFILE
bz completion powershell | Out-String | Add-Content $PROFILE
```

### 试试看

```
bz <TAB>                 # 列出所有命令
bz push --<TAB>          # 列出 push 的 flag（--to/--compress/--concurrency ...）
bz backup rm <TAB>       # 列出已注册的备份任务 id（读本地 backups.json）
bz account use <TAB>     # 列出本地账号名
bz push ./<TAB>          # 原生文件补全
```

> **云端 bundle id / 云端路径**的动态补全本轮未做（需联网列目录且体验会卡顿）；规格已预留，后续可接。
