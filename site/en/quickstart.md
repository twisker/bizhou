---
title: Quick start
parent: English
nav_order: 2
---

# Quick start

Assuming you've [installed](./install.html) `bz` and have your Baidu credentials ready, just start using it. (If you run from source, replace `bz` with `bun packages/cli/src/index.ts`.)

## 1. Initialize (one-time)

```bash
bz init      # set the master password, generate a recovery key
```
> **Write down the recovery key and store it offline** — it's the only fallback if you forget your master password. Forgot to? `bz vault recovery-key` re-exports the same one (master password required).

`bz init` **refuses weak master passwords**; use a passphrase of four or five unrelated words (stronger *and* easier to remember). Why: an encrypted copy of your vault is stored in your netdisk, which lets the provider brute-force it offline, making password strength the only remaining boundary — what you get in return is the new-machine recovery in step 5. To opt out, add `--no-cloud-vault` (at the cost of permanent lockout when you change machines).

## 2. Log in to Baidu

```bash
bz login     # browser OAuth (or bz login --device for the device-code flow)
```

## 3. Encrypted upload / restore download

```bash
# Encrypted upload (auto chunk/encrypt, with a preview)
bz push ./important.zip --preview
#   → prints a resource ID

# List your resources (shows real names)
bz ls

# Preview (text/archive listing prints; image/video/PDF write a file)
bz preview <resourceID>

# Restore into the file root (default: OS Downloads dir)
bz pull <resourceID>
```
The cloud stores only ciphertext and cannot see your filenames or content; the restored file is **byte-for-byte identical** to the original.

## 4. Directory trees / whole-tree encrypted backup

```bash
bz mkdir /work/2026
bz push ./somedir -r --to /work/2026     # encrypt & upload a whole directory tree (mirrors structure)
bz ls /work -r                           # recursive listing (real names)
bz pull /work/2026 -r                     # restore the whole tree into the file root
bz mv /work/2026 /archive                 # the cloud is real folders too: mv/cp/rename
bz rm <resourceID>                        # delete to the recycle bin (managed via bz trash)
```

## 5. New machine / reinstall: just your master password

Nothing to carry over:

```bash
bz login      # sign in to the same Baidu account
bz unlock     # enter your master password — the vault is fetched automatically
bz ls         # everything is there
```

Upgrading from v1.0.x? Back-fill the cloud copy once:

```bash
bz vault sync     # verifies your password, checks strength, then uploads
bz vault status   # check local / cloud state any time
```

## 6. Idempotency, resume, concurrency (automatic, worry-free)

- **Push the same file again** → content dedup finds it already exists and **skips** it — no duplicates.
- **Interrupted mid-transfer** → just **re-run the same command** to resume (same key & uploaded chunks reused; downloads use a temp file with atomic landing + end-to-end verification on completion).
- **Want it faster** → `bz push bigfile --concurrency 8` (default 4, range 1–16).
- **Force** → `--force` bypasses dedup/in-flight-lock.

## 7. Automatic backup (optional)

```bash
bz backup add ~/important-dir    # register a backup job
bz daemon                        # foreground: back up on change + periodic sweep (Ctrl-C to exit)
```
See [Backup & daemon](./guide-backup.html).

## 8. Shell completion (optional)

```bash
eval "$(bz completion bash)"     # bash (zsh / powershell in the completion guide)
```

Next → [Core concepts](./concepts.html) · [Command reference](./commands.html)
