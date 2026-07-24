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
| `--local <dir>` | use a local directory instead of Baidu Netdisk (offline/self-hosted) |
| `--password-stdin` | read the master password from stdin (scripting) |
| `-h`, `--help` | show help |
| `-v`, `--version` | show version |

---

## Keys & session

### `bz init`
Set the master password for the first time and generate a **recovery key** (write it down!). Creates the vault under the key root.

### `bz unlock [--ttl <seconds>]`
Enter the master password to unlock this device's session (caches the master key for a while so later commands don't re-prompt). `--ttl` sets the cache duration.

### `bz lock`
Lock immediately, clearing the cached master key.

### `bz passwd`
Change the master password (recovery key unchanged; only MK is re-wrapped, no resource touched).

### `bz recover`
Reset the master password using the recovery key (the fallback when you forget it).

---

## Accounts (Baidu OAuth)

### `bz login [--name <n>] [--device] [--port <p>]`
OAuth login to Baidu. Default: browser auth + local callback; `--device` uses the device-code flow; `--port` sets the callback port; `--name` labels the account.

### `bz logout`
Log out the current account.

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

> If Baidu's recycle-bin management API is unavailable, `trash` points you to the Baidu Netdisk app/web; deleting into the native recycle bin itself works.

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
