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
- **Data exposure from a lost machine**: keys are never in the cloud and the cloud holds only ciphertext; whoever finds your old machine still cannot open anything without your master password.
- **Data *loss* from a lost machine**: since v1.1.0 an encrypted copy of the vault lives in your own netdisk (see "Cloud vault" below), so a new machine needs only a login plus your master password.

**Does not protect against (out of scope):**
- ⚠️ **Offline brute force against the vault ciphertext**: once the vault is in the cloud, the provider holds that ciphertext and can try master passwords offline, without limit. scrypt (N=2¹⁷, 128 MiB, memory-hard) makes each guess expensive but **cannot save a weak password**. That is why `bz init` refuses weak master passwords. Users who chose `--no-cloud-vault` are outside this exposure, but carry the risk of losing the vault file instead (see [FAQ](./faq.html)).
- **A compromised device**: the master password/master key live in local memory and keychain; if the host is owned, so are you.
- **A weak master password brute-forced**: use a strong one (scrypt raises the cost but can't save a too-weak password). This carries considerably more weight once the vault is in the cloud — see above.
- **Metadata inference**: chunk counts/sizes, directory structure, etc. are observable side channels (see the table above).
- **Availability**: never-delete-from-cloud protects against accidental deletion but is not a substitute for multi-replica disaster recovery.

## Cloud vault (v1.1.0)

The vault (`vault.json`) contains only two ciphertexts: the master key MK wrapped by the password-derived KEK and by the recovery key. Without the master password or the recovery key it is an opaque blob. So since v1.1.0 it is uploaded **as-is** to your own netdisk (opaque filename; `bz ls` never shows it).

**This is a deliberate trade, not a free improvement:**

| | Before (v1.0.x) | After (v1.1.0) |
|---|---|---|
| To reach the vault, an attacker | must first get your device | the provider already holds it |
| Brute-forcing the master password | gated by getting the device | offline, unlimited |
| Lost device / new machine | **data permanently locked** unless you backed up the key root | log in + master password |

What comes with it:
- KDF raised from scrypt N=2¹⁵ to **N=2¹⁷** (128 MiB, memory-hard). Parameters are recorded inside each vault file, so **older vaults keep unlocking with their original parameters**.
- `bz init` / `bz vault sync` enforce a **blocking** password-strength check; below the bar, nothing is uploaded.
- The cloud filename is opaque. **This is not a security boundary** — the engine is open source and the naming rule is public; it only defeats naive pattern matching. Confidentiality comes from the ciphertext alone.
- Prefer to opt out? `bz init --no-cloud-vault`, at the cost of permanent data loss on a new machine, reinstall, or dead disk unless you back up the key root yourself.

## Privacy red lines (engineering constraints)

- Keys/credentials are **never committed, never written to plaintext logs**; `.env`, the vault, `device.key`, tokens are never committed, printed, or put in test snapshots.
- The core lib **only emits progress events — never prints**; all password input/confirmation stays in the CLI layer.
- Upload journals / backup config / manifest cache contain **no keys** (only ids/seqs/timestamps/pid/the MK-wrapped wrappedKey/encrypted-state manifest).
- Any decryption path that hits a GCM failure / wrong master password must **error out**, never silently returning corrupt data.

## Back up your recovery key

The recovery key from `bz init` is the **only** password-forgotten fallback. Write it down offline and store it safely (password manager / paper in a safe). Losing both the master password and the recovery key = data permanently undecryptable (that's the cost and the guarantee of end-to-end encryption).
