---
title: Command reference
parent: English
nav_order: 4
---

# Command reference

Below, `bz` denotes the CLI (replace with `bun packages/cli/src/index.ts` when running from source).

**Common options** (available on most commands):

| Option | Description |
|---|---|
| `--local <dir>` | use a local directory instead of Baidu Netdisk (local/self-hosted) |
| `--password-stdin` | read the master password from stdin (scripting) |
| `-h`, `--help` | show help |
| `-v`, `--version` | show version |

---

## Keys & session

### `bz init [--no-cloud-vault]`
Set the master password for the first time and generate a **recovery key** (write it down!). Creates the vault under the key root and, by default, uploads an **encrypted copy** to your netdisk — the prerequisite for "a new machine needs only your master password".

That is why the master password goes through a **blocking** strength check: once the vault is in the cloud, the provider holds that ciphertext and can brute-force it offline without limits, making password strength the only remaining boundary. Below the bar the command refuses and tells you exactly why (a passphrase of four or five unrelated words is the easiest fix).

`--no-cloud-vault` skips the upload and keeps the vault local only. The cost: a new machine, a reinstall, or a dead disk locks your data **permanently** unless you back up the key root yourself.

### `bz unlock [--ttl <seconds>]`
Enter the master password to unlock this device's session (caches the master key for a while so later commands don't re-prompt). `--ttl` sets the cache duration.

If this machine has no vault, it is **fetched from the cloud automatically** (moving machines). Conversely, if the machine has one and the cloud does not (v1.0.x users), the password you just typed is strength-checked and the vault backfilled — below the bar it only warns and uploads nothing.

### `bz lock`
Lock immediately, clearing the cached master key.

### `bz passwd`
Change the master password (recovery key unchanged; only MK is re-wrapped, no resource touched).

### `bz recover`
Reset the master password using the recovery key (the fallback when you forget it). The cloud copy is updated afterwards.

### `bz vault sync`
Upload this machine's vault to the cloud (the upgrade path for v1.0.x users). **Always re-prompts for the master password**: it proves you are the owner and is the only moment the strength check can be made.

### `bz vault status`
Show local / cloud vault state and whether they match (no password needed). If you changed your master password and the cloud copy lagged behind, this says so.

### `bz vault recovery-key [--rotate]`
Re-export the recovery key. By default you get **the same string as at init time**; `--rotate` mints a new one (**the old one is void immediately**; uploaded resources are unaffected), which is the only path for vaults created before v1.1.0.

**The entry always re-prompts for the master password** — an already-unlocked session does not count. A recovery key is a long-lived credential that changing your password cannot revoke, so whoever borrows an unlocked device must not be able to walk away with it.

---

## Accounts (Baidu OAuth)

### `bz login [--name <n>] [--device] [--port <p>]`
OAuth login to Baidu. Default: browser auth + local callback; `--device` uses the device-code flow; `--port` sets the callback port; `--name` labels the account.

### `bz logout`
Log out the current account.

### `bz quota`
Show netdisk total / used (via Baidu `/api/quota`). Failures raise an error rather than rendering as 0.

### `bz account [list | use <name> | add <name>]`
Multi-account management: list / switch / add. Each account has its own token and `/apps/bizhou/` space.

---

## Upload / download

### `bz push <path> [options]`
Encrypted upload. **Dedup / resume / in-flight-lock / concurrency** apply automatically.

| Option | Description |
|---|---|
| `-r`, `--recursive` | encrypt & upload a whole directory tree (mirrors the structure) |
| `--to <cloud dir>` | explicit cloud destination (default mirrors relative to the file root) |
| `--chunk <size>` | logical chunk size (e.g. `100MB`, default 100MB) |
| `--compress` | gzip before upload |
| `--no-split` | no chunking (whole file as one chunk) |
| `--name <n>` | override the display real name |
| `--preview` | generate & encrypt a preview (media/PDF/text/archive listing, see `preview`) |
| `--force` | bypass dedup and the in-flight lock, force upload |
| `--concurrency <N>` | 4MB-slice concurrency within a chunk (default 4, range 1–16) |

```bash
bz push ./report.pdf --to /work --compress --preview
bz push ./project-dir -r --concurrency 8
```

### `bz pull <id | cloud dir> [options]`
Download & restore into the **file root** (mirrors the cloud structure). **Idempotency / resume / end-to-end verify / atomic landing** apply automatically.

| Option | Description |
|---|---|
| `-r`, `--recursive` | recursively restore a whole cloud subtree |
| `--out <dir>` | destination subdir (within the file root); defaults to mirroring the cloud structure |
| `--force` | bypass idempotency and the in-flight lock, force download |

```bash
bz pull 3af8...c9   --out archive
bz pull /work/2026 -r
```

---

## Directories & resource management

### `bz mkdir <dir>`
Create a cloud directory (`mkdir -p` semantics).

### `bz ls [dir] [-r]`
List directory contents (shows **real names**, requires unlock). `-r` recurses.

### `bz info <id>`
View resource metadata (real name, size, chunks, content fingerprint, preview, ...).

### `bz mv <src> <dst dir>`
Move a bundle or directory under the destination directory.

### `bz cp <src> <dst dir> [-r]`
Copy a bundle or directory (directories need `-r`) under the destination directory.

### `bz rename <src> <new name>`
Rename: a bundle's **real name** (rewrites the encrypted encMeta; chunks and keys untouched); a directory renames natively.

### `bz rm <path | id> [--yes]`
Delete to the **recycle bin**. Deleting a directory requires `--yes`.

### `bz trash [list | restore <id> | rm <id> | clear]`
Recycle-bin management: list / restore / permanently delete one / clear all.

> Baidu's open platform offers no recycle-bin management API, so the recycle bin lives inside the app sandbox at `/apps/bizhou/.trash/`:
> list / restore / delete one / clear all work, with the same semantics as the `--local` backend.
> Note that trashed items still consume netdisk quota until `bz trash clear`.

---

## Sharing / preview

### `bz share <id> [--code | --7z] [--out <dir>]`
- `--code`: export the resource's **DEK share code** (revocable); the holder can decrypt that resource.
- `--7z`: export a **7z-AES single package** (with header encryption); any third party can open it with 7-Zip / Keka / p7zip + the password.

### `bz preview <id> [--out <dir>]`
Download and decrypt the preview package:

| Source type | Preview | Displayed as |
|---|---|---|
| image / video | 320px thumbnail | a `.jpg` file |
| audio | first 15s clip | a `.mp3` file |
| PDF | first-page thumbnail | a `.jpg` file (needs pdftoppm) |
| text / code | first 32KB | **printed to stdout** |
| archive (zip/tar/tgz) | file listing (≤500 entries) | **printed to stdout** |

Previews are generated at `push --preview`, stored separately-encrypted, invisible to the cloud.

---

## Backup / daemon

### `bz backup add <local dir> [--to <cloud dir>]`
Register an encrypted backup job (stored under the key root).

### `bz backup list`
List backup jobs (id / local dir / cloud dir / last backup time).

### `bz backup rm <id>`
Remove a backup job (does **not** touch already-backed-up cloud data).

### `bz backup run [<id>]`
Run one backup now (omit id to run all). Idempotent: unchanged files are skipped.

### `bz daemon`
Foreground daemon: **initial sweep + live watch (back up on change) + periodic sweep**, all sharing one idempotent backup engine. `Ctrl-C` (or SIGTERM) exits **gracefully** (waits for in-flight backups). Backup semantics **never delete from the cloud** (local deletions are not mirrored).

See [Backup & daemon](./guide-backup.html).

---

## Other

### `bz completion <bash | zsh | powershell>`
Print the completion script for the given shell. `eval` it or write it into an rc file. See [Sharing & shell completion](./guide-share-completion.html).

```bash
eval "$(bz completion bash)"                 # current session
bz completion zsh > "${fpath[1]}/_bz"        # zsh, persistent
bz completion powershell | Out-String | Invoke-Expression   # PowerShell, current session
```
