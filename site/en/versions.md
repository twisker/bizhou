---
title: Versions & compatibility
parent: English docs
nav_order: 9
---

# Versions & compatibility

What changed in each release, **whether data written by older versions is still readable**, where to get older versions, and why this tool never updates itself.

---

## Compatibility promise

For an encryption tool the promise that matters is not "many features" but **what you uploaded three years ago still comes back today**. So:

| Promise | What it means |
|---|---|
| **Ciphertext format is backward compatible** | Any version of `bz` can open bundles uploaded by any earlier version. The chunk format, manifest schema, and `encMeta` layout only gain fields; they never change meaning. |
| **Vaults are forward compatible** | KDF parameters (scrypt N/r/p) are recorded **inside each vault file** and used when unlocking — not the current build's defaults. A vault created by v1.0.x with N=2¹⁵ unlocks normally on v1.1.0, with no migration and no silent rewrite. |
| **Irreversible actions stay explicit** | Anything that would make old data unreadable (e.g. `bz init --force`, which mints a new master key) always requires you to type the flag. It never happens on its own. |
| **Downgrading works** | Reinstalling an older version still reads old data. But **old versions don't know about new features**: v1.0.x won't look for a cloud vault and doesn't understand entries in the `.trash` recycle bin. |

> The only exception would be labelled a **breaking change** and could only appear in a major release. So far there has been none.

---

## Releases

### v1.1.0 — Cloud vault

**The problem it fixes:** in v1.0.x the vault (`vault.json`) lived only on your machine and was never uploaded. Without it, neither the master password nor the recovery key opens anything — a new machine, a reinstall, or a dead disk locked your cloud data **permanently**, while the docs wrongly promised "a new machine needs only your master password".

- **Encrypted vault in the cloud**: `bz init` stores a copy in your own netdisk by default; a new machine needs only `bz login` + `bz unlock`.
- **Master-password strength gate**: once the vault is in the cloud the provider holds that ciphertext and can brute-force it offline without limits, so `bz init` / `bz vault sync` **refuse** weak passwords. Opt out with `bz init --no-cloud-vault`.
- **KDF raised**: scrypt N from 2¹⁵ (32 MiB) to 2¹⁷ (128 MiB). Existing vaults are unaffected (see the table above).
- **Recovery key can be re-exported**: `bz vault recovery-key` (master password required). Vaults created before v1.1.0 can only `--rotate` to a fresh one.
- **Recycle bin on the Baidu backend**: `bz trash list/restore/rm/clear` all work now (built at `/apps/bizhou/.trash/`). Previously you had to dig through the Baidu Netdisk app.
- **Netdisk quota**: `bz quota`.

**How to upgrade:** use your package manager (see [Install](./install.html#upgrading)), then run `bz vault sync` once.

**Upgrade risk:** none to your data. Upgrading touches no uploaded resource and does not rewrite your existing vault file unless you explicitly run `vault sync` or change your password.

### v1.0.0 — First stable release

The full client-side encryption engine + CLI: encrypted upload/restore (byte-identical), concurrent uploads, resumable transfers, content dedup, a real cloud directory tree, recursive whole-tree backup, a backup daemon, multi-format previews, sharing (code / 7z-AES), multiple accounts, shell completion.

**Known issue (fixed in v1.1.0):** six places in the docs wrongly claimed "a new machine needs only your master password". In reality the key root `~/.bizhou` had to be backed up by hand. If you are still on v1.0.x, **either back up your key root now, or upgrade to v1.1.0 and run `bz vault sync`**.

---

## Older versions

**Every past version is kept, permanently.** Nothing is taken down:

- **npm**: `npm i -g @bizhou/cli@1.0.0` (any version). `npm view @bizhou/cli versions` lists them all.
- **GitHub Releases**: [every release](https://github.com/twisker/bizhou/releases) ships its `bizhou-cli-<version>.tgz` and its own release notes.
- **Source**: every version has a git tag (`v1.0.0`, `v1.1.0`, …) so you can rebuild and reproduce it yourself.

Keeping the history is part of what makes an open-source encryption tool trustworthy: anyone can fetch a specific version's source and artifact and check independently that they match.

> **Homebrew / Scoop carry only the latest version** (the norm for both channels). For an older version, use npm or a GitHub Release.

---

## Why there is no auto-update

`bz` **never checks for versions, never self-updates, and sends no telemetry.** Three reasons, most important first:

1. **No beacons.** A version check is a recurring outbound request that reveals "this machine runs this tool". This project deliberately keeps a low profile and does not manufacture that observability.
2. **Auto-updating a tool that holds your only decryption key is an asymmetric risk.** A failed upgrade costs you access to your data; upgrading a few days late usually costs you a feature. That call belongs to you.
3. **Your package manager already does this.** `brew outdated`, `scoop status`, and `npm outdated -g` all report new versions; there is no need to rebuild that.

When something genuinely needs to reach you, `bz` decides from **local state** rather than a version number — for example "your vault isn't in the cloud yet, so a new machine would lock you out" is raised during `bz unlock` from the actual local/cloud state, with no version lookup of any kind.
