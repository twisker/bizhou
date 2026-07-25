# 敝帚 Bìzhǒu v1.1.0 —— 云端保险库 / Cloud vault

> 客户端加密引擎 + 命令行工具（`bz`）——上传前本地端到端加密，云端只存密文；取回自动解密还原、字节级一致。
> A client-side encryption engine + CLI (`bz`) — encrypt locally before upload so the cloud only stores ciphertext; retrieval decrypts automatically, byte-for-byte identical.

Apache-2.0 · Windows / macOS / Linux · 文档 / Docs: <https://twisker.github.io/bizhou/>

---

## 中文

### 这个版本修的是一个会让你丢数据的问题

v1.0.x 的保险库（`vault.json`）**只存在本机、从不上云**。没有它，主密码和恢复密钥都打不开任何东西——换机、重装、硬盘损坏都会让云端数据**永久锁死**。而当时的文档六处错误地承诺"换机只需重输主密码"，照做就会丢数据（该文档错误已在 v1.0.0 发布后即刻修正）。

v1.1.0 从根上解决它：**保险库加密上云**，换机真的只需重输主密码。

### 主要变化

**云端保险库（换机恢复）**
- `bz init` 默认把保险库的加密副本放进**你自己的网盘**。新机器上只需：
  ```bash
  bz login && bz unlock     # 保险库自动取回，全部资源可用
  ```
- 保险库本身就是密文信封（只含被主密码和恢复密钥各包裹一份的主密钥），因此原样上传即可，无需二次加密。云端文件名不透明且 `bz ls` 不显示——但**这不是安全边界**，引擎开源、命名规则公开，保密性只来自密文本身。
- `bz vault status` 查看本机 / 云端状态；`bz vault sync` 是 v1.0.x 用户的升级入口。

**这笔交易的代价，我们写在明面上**
- 上云意味着云服务商持有这份密文，可以**离线、不限次数**地爆破你的主密码（此前攻击者必须先拿到你的设备）。
- 因此 `bz init` / `bz vault sync` 会**拦下强度不足的主密码**，并给出具体改法（推荐四五个不相干的词组成的长短语）。这是拦截式关卡，不是黄色小提示——上云后主密码强度是唯一的安全边界。
- KDF 同步提参：scrypt **N=2¹⁵ → 2¹⁷**（32 MiB → 128 MiB，内存硬）。
- 坚持不上云：`bz init --no-cloud-vault`，代价是换机 / 重装 / 硬盘损坏后数据永久锁死，须自行备份 `~/.bizhou`。

**恢复密钥可以重新导出**
- `bz vault recovery-key` 重新导出**与初始化时相同**的那一串；纸条丢了不必作废重来。
- 入口**强制重输主密码**，不接受"本设备会话已解锁"——恢复密钥是一张改主密码也撤销不掉的长期通行证。
- v1.1.0 之前创建的保险库没有这份副本，用 `--rotate` 换一串新的（旧的立即作废，已上传资源不受影响）。

**百度后端回收站**
- `bz trash list / restore / rm / clear` 对百度后端全部可用（建在 `/apps/bizhou/.trash/`）。此前百度开放平台没有回收站管理接口，只能提示用户去百度网盘 App 里翻。
- 代价：回收站里的内容仍占网盘配额，直到 `bz trash clear`。

**网盘配额**
- `bz quota` 显示总量 / 已用。接口失败时报错，**不会显示成 0**（0 会被读成"网盘空了"或"一点空间都没有"）。

### 升级

```bash
npm i -g @bizhou/cli@latest          # 或 brew upgrade bizhou / scoop update bizhou
bz vault sync                        # v1.0.x 用户跑这一次，把保险库加密上云
```

- **无数据风险**：升级不改动任何已上传资源，也不会改写你现有的保险库文件（除非你主动 `vault sync` 或改密码）。
- **老保险库照常解锁**：KDF 参数记在每个保险库文件内部，v1.0.x 用 N=2¹⁵ 建的保险库继续用它自己的参数，不迁移、不改写。
- 完整兼容性承诺见[版本与兼容性](https://twisker.github.io/bizhou/zh/versions.html)。

### 其它
- `bz` **不联网检查版本、不自动更新、不发遥测**；升级由包管理器驱动。真正需要提醒你的事（如"保险库还没上云"）由本地状态判断得出，不查任何版本号。
- `bun test` 303 全绿 + 1 skip；三平台构建与类型检查通过。

---

## English

### This release fixes a data-loss problem

In v1.0.x the vault (`vault.json`) lived **only on your machine and was never uploaded**. Without it, neither the master password nor the recovery key opens anything — a new machine, a reinstall, or a dead disk locked your cloud data **permanently**. Six places in the docs wrongly promised "a new machine needs only your master password"; following that advice lost data (the doc error was corrected right after v1.0.0 shipped).

v1.1.0 fixes it at the root: **the vault is encrypted and stored in the cloud**, so a new machine really does need only your master password.

### Highlights

**Cloud vault (new-machine recovery)**
- `bz init` stores an encrypted copy of the vault in **your own netdisk** by default. On a new machine:
  ```bash
  bz login && bz unlock     # the vault is fetched automatically; everything is available
  ```
- The vault is already a ciphertext envelope (just the master key wrapped by your password and by your recovery key), so it is uploaded as-is — no second layer needed. The cloud filename is opaque and `bz ls` never shows it, but **that is not a security boundary**: the engine is open source and the naming rule is public. Confidentiality comes from the ciphertext alone.
- `bz vault status` shows local/cloud state; `bz vault sync` is the upgrade path for v1.0.x users.

**The trade-off, stated plainly**
- Putting the vault in the cloud means the provider holds that ciphertext and can brute-force your master password **offline, without limits** (previously an attacker had to get your device first).
- So `bz init` / `bz vault sync` **refuse master passwords that are too weak** and tell you exactly how to fix it (a passphrase of four or five unrelated words is easiest). It is a blocking gate, not a yellow warning — once the vault is in the cloud, password strength is the only remaining boundary.
- The KDF was raised accordingly: scrypt **N=2¹⁵ → 2¹⁷** (32 MiB → 128 MiB, memory-hard).
- Prefer to opt out? `bz init --no-cloud-vault`, at the cost of permanent lockout on a new machine, reinstall, or dead disk unless you back up `~/.bizhou` yourself.

**The recovery key can be re-exported**
- `bz vault recovery-key` re-exports **the same string** you got at init, so a lost note no longer means starting over.
- The entry **always re-prompts for the master password**; an already-unlocked session does not count — a recovery key is a long-lived credential that changing your password cannot revoke.
- Vaults created before v1.1.0 don't carry that copy; `--rotate` mints a fresh one (the old one is void immediately; uploaded resources are unaffected).

**Recycle bin on the Baidu backend**
- `bz trash list / restore / rm / clear` all work now (built at `/apps/bizhou/.trash/`). Baidu's open platform has no recycle-bin management API, so previously we could only point you at the Baidu Netdisk app.
- Cost: trashed items still consume netdisk quota until `bz trash clear`.

**Netdisk quota**
- `bz quota` shows total / used. Failures raise an error rather than **rendering as 0** (which would read as "the netdisk is empty" or "completely full").

### Upgrading

```bash
npm i -g @bizhou/cli@latest          # or brew upgrade bizhou / scoop update bizhou
bz vault sync                        # v1.0.x users: run once to put the vault in the cloud
```

- **No data risk**: upgrading touches no uploaded resource and does not rewrite your existing vault file unless you explicitly run `vault sync` or change your password.
- **Old vaults keep unlocking**: KDF parameters are recorded inside each vault file, so a v1.0.x vault with N=2¹⁵ keeps using its own parameters — no migration, no silent rewrite.
- Full compatibility promise: [Versions & compatibility](https://twisker.github.io/bizhou/en/versions.html).

### Also
- `bz` **never checks for versions, never self-updates, and sends no telemetry**; upgrades are driven by your package manager. Anything that genuinely needs to reach you (like "your vault isn't in the cloud yet") is derived from local state, with no version lookup.
- `bun test`: 303 passing + 1 skipped; builds and type checks pass on all three platforms.
