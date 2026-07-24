---
title: Core concepts
parent: English
nav_order: 3
---

# Core concepts

## End-to-end encryption (keys never leave your device)

- File content is encrypted with **AES-256-GCM** (AEAD: both confidential and tamper-evident; any tampering or wrong password fails authentication and **errors out** — corrupt data is never returned).
- **Envelope + master-key (MK) indirection**:
  - each resource gets a random **DEK** for its content;
  - one random **master key MK** wraps (encrypts) every resource's DEK;
  - MK itself is wrapped twice: by a **password-derived KEK** and by a **recovery key**.
- Benefits: **changing your password** only re-wraps MK — no resource is touched; **forgetting your password** is recovered via the **recovery key** decrypting MK. Without the password or the recovery key, no one can unwrap MK → no DEK → no content.

## Bundle (the physical shape of a resource)

Each "resource" is a **folder** with a `.bz` suffix (just an ordinary folder in other clients):

```
<opaque-id>.bz/
  ├── manifest.json   # chunk info + wrappedKey (MK-wrapped DEK) + encMeta (encrypted metadata) + preview pointer
  ├── 000.part        # encrypted chunk (default ≤100MB each)
  ├── 001.part
  └── preview.part    # encrypted preview package (optional)
```

- The **folder name is opaque and contains no original filename**; the real name, size, and content fingerprint live only inside the **encrypted** `encMeta`.
- Large files are split into **100MB logical chunks** (`--chunk` to adjust) to dodge single-file limits; memory usage is decoupled from file size (only one chunk resides in memory at a time).

## Random cloud name + local real name

- The **cloud** keeps a **random bundle name** (privacy: others see a pile of meaningless folders in your netdisk).
- **Locally / `bz ls`** shows the **real name**, read from the decrypted `encMeta`.
- **Real directory trees**: both cloud and local are real folders; `mkdir` / `ls -r` / `mv` / `cp` / `rename` all work.

## Dual local roots

| Root | Holds | Default | Env |
|---|---|---|---|
| **Key root** | keys, accounts, config, backup jobs, upload/download journals, cache | `~/.bizhou` | `BIZHOU_HOME` |
| **File root** | restored downloaded files | OS Downloads dir | `BIZHOU_FILE_ROOT` |

- **Upload mapping**: `push` by default mirrors the source's position relative to the file root into the cloud; `--to` names an explicit cloud dir. The source need **not** live under the file root.
- **Download mapping**: `pull` brings the cloud directory structure under the file root.

## Content fingerprint (basis of dedup, and it never leaks)

- Dedup uses a **content fingerprint** `contentId = HMAC(key-derived-from-MK, plaintext)`.
- It is stored only inside the **encrypted** `encMeta` — invisible to the cloud; keyed → not a bare hash, and not correlatable across accounts.
- Same plaintext → same contentId (stable within a vault), which is how "this file was already uploaded" is recognized.

## Idempotency · resume · in-flight lock

- **Idempotent dedup**: before uploading, compute contentId; if a completed bundle with the same content already exists in the target dir → skip.
- **Resume**: after an interruption, re-run to reuse the same bundleId + same DEK + already-completed chunks; downloads write to a temp file and only **atomically rename** on completion, plus an **end-to-end contentId check**.
- **In-flight lock**: identical content already uploading to the same destination → you are told and it stops, preventing concurrent duplicates.
- These are carried by a local "journal" file (under the key root) that is both the lock and the resume state, and it contains no keys.

## Chunker & concurrency

- Upload: optional compression → AES-GCM → per-100MB logical chunks → each chunk further split into 4MB transfer slices for upload.
- **Concurrency** happens at the 4MB-slice level (a bounded pool, `--concurrency`, default 4) — because the bottleneck is network I/O, not CPU encryption.

Next → [Command reference](./commands.html) · [Security model](./security.html)
