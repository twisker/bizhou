---
title: Security model
parent: English
nav_order: 7
---

# Security model

## Algorithms & parameters

| Purpose | Scheme |
|---|---|
| Content encryption | **AES-256-GCM** (AEAD: confidentiality + integrity/tamper-evidence) |
| Password → KEK | **scrypt** (password NFKC-normalized first, salted, parameterized, written into the vault for auditability) |
| Key wrapping | AES-256-GCM envelope (KEK wraps MK; MK wraps each resource's DEK) |
| Content fingerprint | **HMAC-SHA256** (key derived from MK via HKDF) |
| Chunk IV | deterministically derived `HMAC-SHA256(DEK, "<bundleId>:<seq>")[:12]`; on resume, chunkSize/compression are pinned to guarantee uniqueness (see tech-spec §5.1.1) |

Zero external crypto dependencies: AES-GCM and the KDF use the runtime's **built-in `crypto`** — cross-platform consistent and auditable.

## Key hierarchy (envelope + MK indirection)

```
master password ──scrypt──▶ KEK_pw ─┐
                                     ├─wraps─▶  MK (random master key) ──wraps─▶ each resource's DEK ──▶ encrypts content
recovery key   ──────────▶ KEK_rk ─┘
```

- **MK** is generated once; each resource's DEK is MK-wrapped and stored in that resource's `manifest.wrappedKey`.
- **Change password**: only re-wrap MK (swap KEK_pw), touching no resource.
- **Forget password**: decrypt MK with the **recovery key** from init.
- Without the master password or the recovery key → no MK → no DEK → **no content at all**. True end-to-end.

## What the cloud can / cannot see

| Cloud can see | Cloud cannot see |
|---|---|
| random bundle folder names (no original filename) | file content (ciphertext only) |
| number of chunks and each chunk's **ciphertext** size | original filename, size, mtime (inside encrypted encMeta) |
| iv/tag/ciphertext-sha256 in the manifest | content fingerprint (HMAC, inside encrypted encMeta, and keyed) |
| the directory tree you created | master password, recovery key, DEK, MK (never leave the device) |

> If you're concerned about exposing the **directory structure itself**, keep all bundles at one level and gather them with `--to`.

## Threat model (what it protects against / doesn't)

**Protects against:**
- Cloud / MITM **reading content**: only ciphertext; GCM guarantees confidentiality.
- Cloud **tampering with content**: GCM tag failure errors out, never returning corrupt data; chunk AAD binds `(bundleId, seq)` to prevent reordering/splicing; downloads also do an end-to-end contentId check.
- **Confirmation attacks**: the content fingerprint is a keyed HMAC stored only in the encrypted encMeta, so an attacker holding a candidate plaintext cannot confirm you stored it.
- **New/lost machine**: keys aren't in the cloud; a new machine just re-enters the master password.

**Does not protect against (out of scope):**
- **A compromised device**: the master password/master key live in local memory and keychain; if the host is owned, so are you.
- **A weak master password brute-forced**: use a strong one (scrypt raises the cost but can't save a too-weak password).
- **Metadata inference**: chunk counts/sizes, directory structure, etc. are observable side channels (see the table above).
- **Availability**: never-delete-from-cloud protects against accidental deletion but is not a substitute for multi-replica disaster recovery.

## Privacy red lines (engineering constraints)

- Keys/credentials are **never committed, never written to plaintext logs**; `.env`, the vault, `device.key`, tokens are never committed, printed, or put in test snapshots.
- The core lib **only emits progress events — never prints**; all password input/confirmation stays in the CLI layer.
- Upload journals / backup config / manifest cache contain **no keys** (only ids/seqs/timestamps/pid/the MK-wrapped wrappedKey/encrypted-state manifest).
- Any decryption path that hits a GCM failure / wrong master password must **error out**, never silently returning corrupt data.

## Back up your recovery key

The recovery key from `bz init` is the **only** password-forgotten fallback. Write it down offline and store it safely (password manager / paper in a safe). Losing both the master password and the recovery key = data permanently undecryptable (that's the cost and the guarantee of end-to-end encryption).
