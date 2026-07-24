---
title: Guide: backup & daemon
parent: English
nav_order: 5
---

# Guide: backup & daemon

Turn "encrypted upload" into "unattended automatic encrypted backup" — register directories, and changes are encrypted to the cloud automatically.

## Mental model

- A **backup job** = `local dir → cloud dir`.
- The only operation is an **idempotent sweep**: walk the local dir, and for each file call the same kernel as `push` — **unchanged files are skipped instantly, changed ones are incrementally uploaded** (reusing dedup/resume/in-flight-lock).
- **Three triggers** all just "run a sweep": initial sweep, file change (debounced), periodic fallback.
- **Backup semantics = never delete from the cloud**: if you delete a file locally, the cloud backup **stays** (protects against accidental deletion, still retrievable); to clear the cloud use `bz rm` / `bz trash`.

## 1. Register backup jobs

```bash
bz backup add ~/Documents/important
bz backup add ~/Code/myproject --to /code-backup/myproject   # explicit cloud destination
bz backup list
#  a1b2c3d4  /Users/me/Documents/important  (mirror)  last: never
#  e5f6a7b8  /Users/me/Code/myproject       → /code-backup/myproject  last: never
```

## 2. Run once manually

```bash
bz backup run              # run all jobs
bz backup run a1b2c3d4     # run one job
#  Job a1b2c3d4 done: uploaded 128, skipped 0, failed 0
```
Run it again and you'll see "skipped 128" — idempotent dedup means unchanged files upload nothing.

## 3. Foreground daemon (automatic)

```bash
bz daemon
#  daemon started: 2 jobs, initial sweep...
#  Job a1b2c3d4: uploaded 128, skipped 0, failed 0
#  Watching (debounce 2000ms, periodic 30min). Ctrl-C to exit.
```

After that:
- **Add/change files** → 2s debounce → that job is incrementally backed up automatically.
- **Every 30 minutes** → a full fallback sweep (catches any missed events).
- **`Ctrl-C` / `SIGTERM`** → graceful exit: stop watching, wait for in-flight backups, wipe the in-memory master key.

> The daemon needs `bz login` + an unlocked vault (or it prompts for the master password at startup). It holds the master key in memory until exit — inherent to unattended backup.

## 4. Backgrounding (your way)

`bz daemon` is a **foreground** process. To run it long-term in the background, use your OS's usual mechanism:

```bash
# simple
nohup bz daemon > ~/.bizhou/daemon.log 2>&1 &

# or manage via systemd (Linux) / launchd (macOS) / Task Scheduler (Windows)
```

## 5. Configurable settings (`config.json`, under the key root)

| Key | Default | Description |
|---|---|---|
| `daemonDebounceMs` | 2000 | file-change debounce window (ms) |
| `daemonSweepIntervalMs` | 1800000 | periodic fallback interval (ms, default 30min) |
| `uploadConcurrency` | 4 | 4MB-slice concurrency (also `push --concurrency`) |
| `fileRoot` | OS Downloads dir | the file root (also `BIZHOU_FILE_ROOT`) |

## A note on cross-platform watching

macOS / Windows use native recursive watching; Linux watches per-directory and relies on the **periodic sweep** to catch omissions like newly-created deep directories — so the periodic sweep is the reliability backbone, and even if a live event is missed, no backup is lost.
