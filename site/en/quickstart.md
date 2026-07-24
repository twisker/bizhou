---
title: Quick start
parent: English
nav_order: 2
---

# Quick start

Run the whole pipeline offline first (no login/network), then switch online. Below, `bz` denotes the CLI; when running from source, replace `bz` with `bun packages/cli/src/index.ts`.

## A. Offline (`--local`, 5 minutes)

Use a local directory instead of Baidu Netdisk to verify "encrypt → store → restore **byte-for-byte identical**".

```bash
# For the demo, put the key root and master password in env (don't do this in production)
export BIZHOU_HOME=/tmp/bz-demo
export BIZHOU_MASTER_PASSWORD=demo-pass
STORE=/tmp/bz-store          # a local dir acting as "the cloud"

# 1) Initialize: set master password, generate a recovery key (write it down!)
bz init

# 2) Encrypt & upload a file (with compression and preview)
bz push ./sample.pdf --local $STORE --compress --preview
#   → prints a resource ID (a hex string) used to fetch it later

# 3) List (shows real names, requires unlock)
bz ls --local $STORE

# 4) Preview (text/archive listing prints; media/PDF write a file)
bz preview <resourceID> --local $STORE

# 5) Restore and verify byte-identity
bz pull <resourceID> --local $STORE --out /tmp/bz-out
diff ./sample.pdf /tmp/bz-out/sample.pdf && echo "byte-identical ✓"
```

Try directory trees and whole-tree backup:

```bash
bz mkdir /work/2026 --local $STORE
bz push ./somedir -r --to /work/2026 --local $STORE   # whole-tree encrypted upload
bz ls /work -r --local $STORE                          # recursive listing (real names)
bz pull /work/2026 -r --local $STORE                   # restore the whole tree into the file root
```

## B. Switch online (real Baidu Netdisk)

```bash
unset BIZHOU_MASTER_PASSWORD          # interactive input is safer in production
bz login                              # OAuth login (browser / --device device code)
# Then drop --local and everything goes to your Baidu Netdisk:
bz push ./important.zip --preview
bz ls
bz pull <resourceID>
```

## C. Idempotency, resume, concurrency (worry-free)

- **Push the same file again**: content dedup detects it already exists in the target dir and **skips** it — no duplicates.
- **Interrupted mid-transfer**: just **re-run the same command** to resume (same key & already-uploaded chunks reused; downloads use a temp file with atomic landing on completion).
- **Want it faster**: `bz push bigfile --concurrency 8` (4MB-slice concurrency within a chunk; default 4, range 1–16).
- **Force**: `--force` bypasses dedup/in-flight-lock.

## D. Automatic backup (optional)

```bash
bz backup add ~/important-dir     # register a backup job
bz daemon                         # foreground: initial sweep + back up on change + periodic (Ctrl-C to exit)
```
See [Backup & daemon](./guide-backup.html).

## E. Shell completion (optional)

```bash
# bash: add to ~/.bashrc
eval "$(bz completion bash)"
# zsh / powershell: see the Sharing & shell completion guide
```

Next → [Core concepts](./concepts.html) · [Command reference](./commands.html)
