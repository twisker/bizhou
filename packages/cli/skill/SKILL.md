---
name: bizhou-encrypt
description: 用敝帚（bz）在上传到百度网盘前对文件做客户端端到端加密，以及下载还原、列举、分享。当用户要"加密上传/取回文件到网盘""端到端加密备份""不让云端看到内容"时使用。
---

# 敝帚（bz）加密引擎 Skill

`bz` 是一个客户端加密 CLI：上传前本地 AES-256-GCM 端到端加密，云端只存密文；取回自动解密还原、字节级一致。核心库 `@bizhou/core` 亦可直接嵌入。

## 非交互调用（agent/脚本）

所有需要主密码的命令都可通过环境变量免交互：

- `BIZHOU_MASTER_PASSWORD=<主密码>` —— 免交互提供主密码
- `BIZHOU_CONFIG_DIR=<目录>` —— 指定配置/密钥库位置（隔离运行环境）
- `--password-stdin` —— 从 stdin 读主密码
- `--local <目录>` —— 用本地目录代替百度网盘（离线/自建后端，便于测试）
- 凭证：`.env` 内 `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`

命令向 stderr 输出人类可读信息与进度，向 stdout 输出可被脚本消费的结果（资源 ID、列表、分享码）。退出码分类：0 成功；2 参数；3 认证/主密码错；4 OAuth；5 百度接口；6 数据完整性；7 账号/vault。

## 典型流程

```bash
# 初始化（生成恢复密钥，stdout 打印一次）
BIZHOU_MASTER_PASSWORD=... bz init
# 登录百度（交互/设备码；需真实网络）
bz login --device
# 加密上传，stdout 末行给出资源 ID
BIZHOU_MASTER_PASSWORD=... bz push ./report.pdf --compress
# 列出资源（显示解密后的真名）
BIZHOU_MASTER_PASSWORD=... bz ls
# 下载还原
BIZHOU_MASTER_PASSWORD=... bz pull <id> --out ./restored
# 生成分享码（该资源 DEK）
BIZHOU_MASTER_PASSWORD=... bz share <id> --code
```

## 安全须知

- 主密码、恢复密钥、DEK/KEK、百度 token 只在本地；不上传、不入库、不写明文日志。
- 云端只见不透明文件夹名与密文，读不到原文件名或内容。
- 无主密码任何人都解不开；忘主密码用 `bz recover` + 恢复密钥。
