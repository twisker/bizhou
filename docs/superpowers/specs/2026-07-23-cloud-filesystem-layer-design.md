# 敝帚 v2 · 云端文件系统层 — 设计文档

- 状态：设计已确认，待写实现计划
- 日期：2026-07-23
- 关联：PRD `design/PRD.md`（§6 数据模型、§11 百度集成、§14 CLI）；本文件在 M0/M1 完成（v0.1.25）之上扩展。

---

## 1. 背景与目标

M0/M1 交付了单文件的客户端加密上传/下载：bundle 以**不透明随机名** `<id>.bz` **扁平**存放在云端沙盒 `/apps/bizhou/`，真名加密存 encMeta。

本设计把它升级为一个**云端文件系统层**，让敝帚从"单文件加密"变成"**整个文件夹的加密云备份/还原 + 类文件系统管理**"。

### 目标
1. **真实目录树**：在 `/apps/bizhou/` 下支持真实子目录（组织文件、并规避单目录条目数上限）。
2. **真名显示**：`bz ls` 显示 bundle 的真实文件名（读 encMeta），云端 bundle 名保持随机。
3. **目录/文件的改名、删除、移动、复制/剪切**。
4. **删除进回收站**（默认），支持还原/清空/单独/批量清除。
5. **两个可配置的本地根**：密钥根、文件根。
6. **灵活的云↔本地目录映射**（非固定镜像，上传可指定云端目录）。
7. **递归操作**（`-r`）：整树上传/下载/列出/删除/复制。

### 非目标
- 不改动加密内核（AES-256-GCM 信封 + MK/DEK）与 bundle 内部结构（分片/manifest/encMeta）。
- 不搞独立的加密索引与索引同步（真名的事实来源就是每个 bundle 的 encMeta）。
- 不改动云端沙盒根（百度硬约束，见 §3）。
- 不做移动端 / GUI。

---

## 2. 两个本地根（均可配置）

| 根 | 用途 | 默认值 | 配置来源（优先级高→低） |
|---|---|---|---|
| **密钥根 `keyRoot`** | vault.json、secrets.enc、device.key、本地缓存 | `~/.bizhou` | 环境变量 `BIZHOU_HOME` → 内置默认 |
| **文件根 `fileRoot`** | 下载解密后文件的落地根 | 操作系统当前用户**下载目录**（mac/Linux `~/Downloads`，Win `%USERPROFILE%\Downloads`） | 环境变量 `BIZHOU_FILE_ROOT` → `keyRoot/config.json` 的 `fileRoot` → 内置默认 |

- **配置文件**：`keyRoot/config.json`（可存 `fileRoot` 等）。密钥根本身**不**从配置文件读（它就是配置文件所在地）——只由 `BIZHOU_HOME` 或默认决定，避免鸡生蛋。
- 兼容：保留 `BIZHOU_CONFIG_DIR` 作为 `BIZHOU_HOME` 的**弃用别名**（若设置则等价于 `BIZHOU_HOME`）。
- 下载目录探测：默认 `join(homedir(), "Downloads")`；Linux 可后续接 `XDG_DOWNLOAD_DIR`（v1 用默认即可）。

---

## 3. 云端存储模型

- **云端根固定 `/apps/bizhou/`**——百度开放平台沙盒强制（应用只能读写 `/apps/{产品名}/`）。**不可搬走**，只能在其下建树。
- 其下为**真实百度目录树**：目录是真实 Baidu 文件夹，**云端可见目录名**。
- bundle 仍为 `<随机ID>.bz` 文件夹（内含 `manifest.json` + `NNN.part` + 可选 `preview.part`）；**云端不可见原文件名**（真名 + 大小 + mtime 加密在 encMeta）。
- **向后兼容**：M0/M1 上传的扁平 bundle 即"根目录下的 bundle"，在新模型里天然出现在根 `ls` 中，无需迁移。

### 隐私定性（元数据层）
- **内容**：始终端到端加密，云端不可读。
- **文件名**：隐藏（encMeta 加密）。
- **目录名/结构**：**云端可见**（这是换取原生目录操作的自觉取舍，用户已确认）。需要连目录都藏时，走 `bz share --7z`（头部加密）导出。

---

## 4. 路径与寻址

### 云端路径
形如 `/工作/2026/报告.pdf`（相对云端根 `/apps/bizhou/`）。解析：
1. 拆成目录路径 `/工作/2026` + 叶子名 `报告.pdf`。
2. 逐级走**真实目录**（按真实目录名，native list）。
3. 叶子目录内：子目录按目录名匹配；bundle 按其 **encMeta 真名**匹配（需 MK 解密各 bundle 的小 manifest）。
4. 叶子既可指向目录，也可指向 bundle。

### 按 ID / 短前缀
- 仍支持完整 32 位 ID 与 `bz ls` 显示的 12 位短前缀（沿用现有 `resolveId`，但需扩展为在目录树内查找）。

### 重名冲突
- 同一目录下两个 bundle 真名相同 → 路径 `.../报告.pdf` **有歧义** → 报错并列出候选短 ID，提示用 ID 定位。
- 上传不阻止真名重复（bundle 名随机、天然不冲突）；歧义只在**按路径寻址**时暴露并提示。

### 性能说明
- `ls` 需读该目录下每个 bundle 的 manifest 以取真名 → 多次小下载。可接受；大目录慢时，未来可在密钥根加**只读本地缓存**（非事实来源，可随时重建）。v1 按需读，不做缓存。

---

## 5. 上传映射（来源可在文件根之外）

`bz push <来源> [--to <云端目录>] [-r]`

- `<来源>` **不必**在文件根之下。
- **缺省 `--to` 的统一规则**：让 `<来源>` 落到其**相对文件根的镜像位置**——即取 `<来源>` 的**父目录**相对文件根的路径作为云端目录；`<来源>` 不在文件根之下时该路径视为空 → 缺省 = 云端根 `/apps/bizhou/`。
  - 单文件例：`fileRoot=~/Downloads`，来源 `~/Downloads/工作/报告.pdf` → 缺省 `--to=/apps/bizhou/工作/`，落 `/apps/bizhou/工作/报告.pdf`。
  - 单文件例（文件根外）：来源 `/tmp/foo.pdf` → 缺省 `--to=/apps/bizhou/`，落 `/apps/bizhou/foo.pdf`。
  - 目录例（`-r`）：来源 `~/Downloads/工作` → 父目录相对文件根为空 → 缺省 `--to=/apps/bizhou/`，在其下建 `工作/` 镜像整棵子树（`/apps/bizhou/工作/…`）。
- `--to` 显式指定则覆盖缺省。
- 目标云端目录不存在时**自动创建**（mkdir -p 语义）。
- `-r`（来源为目录）：递归上传整棵本地子树，在 `<--to>/<来源目录basename>/…` 下镜像重建目录结构，每个文件加密为一个 bundle。单文件（无 `-r`）直接落入 `<--to>/`（不加 basename 子目录）。

## 6. 下载映射（必落文件根之下，带入云端结构）

`bz pull <云端路径|id> [-r] [--out <文件根内子目录>]`

- 落地路径 = `<fileRoot>/<资源的云端相对路径>`。例：云端 `/apps/bizhou/工作/2026/报告.pdf` → `<fileRoot>/工作/2026/报告.pdf`（真名还原，云端子目录 `工作/2026` 原样重建于文件根下）。
- `-r`（云端路径为目录）：递归还原整棵云端子树到文件根下对应位置。
- `--out` 可指定文件根内的一个子目录作为落点前缀（可选；默认按云端相对路径）。下载始终在文件根之下。

---

## 7. 命令面

```
bz mkdir <云端目录>                     建目录（native，mkdir -p）
bz ls [云端目录] [-r]                   列出：子目录 + bundle 真名/大小/时间；-r 递归整树
bz push <来源> [--to <云端目录>] [-r]     加密上传；来源可在文件根外；-r 递归上传本地文件夹
bz pull <云端路径|id> [-r] [--out <子目录>] 下载还原到文件根下；-r 递归还原整树
bz mv <源> <云端目标目录>                移动 bundle/目录（native filemanager move；移目录天然递归）
bz cp <源> <云端目标目录> [-r]            复制（native filemanager copy；-r 递归复制目录子树）
bz rename <bundle> <新名>               改真名（读 MK→改 encMeta→重传 manifest；随机夹名/.bz 不动）
bz rename <云端目录> <新名>              原生改目录名
bz rm <云端路径> [-r] [--yes]           删除 → 百度原生回收站；-r 递归删目录（大树需 --yes 二次确认）
bz trash [list | restore <x> | rm <x> | clear]  回收站管理（见 §8）
```

- 现有命令保留：`init/unlock/lock/passwd/recover/login/logout/account/info/preview/share`。
- `info` 支持云端路径或 ID。
- 不带 `-r` 对目录执行 `rm/cp/ls`：`rm`/`cp` 报"需 `-r`"；`ls` 只列该层。
- **存储后端无关**：以上全部经 `BundleStore` 抽象；`--local <dir>` 仍表示用本地目录当后端（离线/自建），目录树模型对本地后端同样适用。

---

## 8. 回收站（百度原生 + 兜底提示）

- **删除**：`bz rm` 走 `filemanager opera=delete` → 文件进**百度原生回收站**（可在百度 App/网页还原）。需求 7 天然满足、零额外存储。
- **管理**（需求 8：list/restore/clear/单独删）：
  - 尝试百度**回收站相关接口**（`recycle/list`、`recycle/restore`、`recycle/clear` 等）。
  - **已知风险**：这些接口大概率属**网页版 API（需 bdstoken/cookie）**，未必在**开放平台 access_token 接口**内暴露 —— 与整套百度对接一样，**须真机验证**。
  - **不支持时的行为**：`bz trash *` 打印清晰提示，引导用户到**百度网盘 App/网页的回收站**进行相应操作（**不**自建 `.trash`）。

---

## 9. 组件与边界（在现有架构上扩展）

| 组件 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `paths`（扩展 config） | `core/src/config` | 解析 keyRoot / fileRoot / 下载目录 / config.json | env、platform（注入） |
| `cloudpath` | `core/src/cloudpath`（新） | 云端路径拆分/规范化、上传缺省云端目录计算、下载落地路径计算 | 纯函数 |
| `BundleStore`（扩展） | `core/src/store`、`core/src/baidu/store` | 增加目录级操作：mkdir、list（含子目录）、move、copy、rename、delete→回收站、trash 管理 | client |
| `BaiduClient`（扩展） | `core/src/baidu/client` | 增加 filemanager move/copy/rename、mkdir、recycle 接口封装 | http |
| `fs-ops`（编排） | `core/src/fsops`（新） | 树遍历、递归 push/pull、路径→bundle 解析（读 encMeta 匹配真名）、重名歧义处理 | store、resource、vault |
| CLI 命令（扩展） | `cli/src/commands`、`cli/src/index` | mkdir/ls(-r)/push(-r,--to)/pull(-r)/mv/cp(-r)/rename/rm(-r)/trash | fsops、runtime |
| `runtime`（扩展） | `cli/src/runtime` | 解析 keyRoot/fileRoot；current dir 无（v1 用显式路径） | config |

- **纯函数优先**：`cloudpath` 的所有路径计算（缺省云端目录、下载落地）为纯函数、可单测，不碰 IO。
- 核心库仍"只发进度事件、不 print"。

---

## 10. 错误处理

| 情形 | 行为 |
|---|---|
| 云端路径不存在 | `INVALID_ARG`，提示最接近的已有路径 |
| 按路径寻址真名歧义 | `INVALID_ARG`，列候选短 ID |
| `rm`/`cp` 对目录但无 `-r` | `INVALID_ARG`，提示加 `-r` |
| `rm -r` 大树 | 需 `--yes`，否则打印将删项数并要求确认 |
| 上传来源不存在 / 无权限 | `IO` |
| 目标云端目录创建失败 | `BAIDU`（errno 透传） |
| move/copy 目标冲突 | 透传百度 errno，给可读说明 |
| 回收站管理接口不支持 | 打印引导去百度 App 的提示（非错误退出，或 `INVALID_ARG` 视命令语义） |
| token 过期 | 复用现有 refresh 逻辑自动刷新 |
| 分片上传/下载瞬时失败 | 复用现有指数退避重试 |

---

## 11. 测试策略

- **纯函数单测**（`cloudpath`）：上传缺省云端目录计算（来源在/不在文件根、多级、Win 路径分隔）、下载落地路径映射、路径拆分/规范化、配置根解析优先级。
- **集成（`LocalBundleStore` + 真实本地子目录，离线可跑）**：mkdir/ls(-r)/push(-r)/pull(-r)/mv/cp(-r)/rename/rm(-r) 全流程；**递归整树 push→pull 字节级一致**（多层目录、含真名还原）；重名歧义、无 `-r` 守卫、`rm -r --yes`。
- **回收站**：本地后端模拟 delete→trash 目录 + list/restore/clear（本地后端可完整实现，用于验证命令逻辑）；百度后端的回收站管理走 `BIZHOU_LIVE` 联网测试。
- **联网（`BIZHOU_LIVE=1`）**：真实百度上做一次小目录树的 push -r → pull -r 往返、mv/cp/rename/rm、trash 探测（确认开放 API 是否支持管理）。

---

## 12. 安全考量

- 内容加密不变；**目录名对云端可见**是自觉取舍（§3）。文档与 `bz` 帮助里明示，避免用户误以为目录名也被隐藏。
- `rename` bundle 需 MK（改 encMeta）；不泄露真名到云端明文。
- 递归删除有 `--yes` 护栏，防误删整树。
- 回收站不自建，避免额外明文元数据（还原路径等）落云端。

---

## 13. 实现分阶段（供 writing-plans 细化）

- **阶段 1 · 本地根 + 目录树基础**：config 双根（keyRoot/fileRoot）+ config.json；`cloudpath` 纯函数；`BundleStore`/client 增 mkdir/list(子目录)；`bz mkdir/ls`（含 `-r`）。
- **阶段 2 · 上传/下载映射（含递归）**：`push --to`（缺省云端目录计算，来源可在文件根外）、`pull`（落文件根、带入结构）；`push -r`/`pull -r` 整树；路径→bundle 解析 + 重名歧义。
- **阶段 3 · 文件操作**：`mv`、`cp`(`-r`)、`rename`（bundle=encMeta / 目录=native）。
- **阶段 4 · 回收站**：`rm`→原生回收站（`-r`/`--yes`）；`trash list/restore/rm/clear`（原生，不支持则提示）；联网验证回收站开放 API 支持度。

---

## 14. 开放风险

- **回收站管理开放 API 支持度未知**（§8）——须真机验证；不支持则退化为"删除进回收站 OK + 管理去百度 App"。
- `ls` 读 encMeta 的性能（大目录）——v1 按需读，必要时后续加只读本地缓存。
- 云端目录名可见的隐私取舍——已与用户确认，文档明示。
