---
title: FAQ
parent: English
nav_order: 8
---

# FAQ

### I forgot my master password. Now what?
Use `bz recover` + the **recovery key** generated at init to reset the master password. **Lose both** = data undecryptable (inevitable with end-to-end encryption). Always store the recovery key offline.

Your recovery key unwraps the ciphertext held in the **vault**. Since v1.1.0 an encrypted copy of the vault is stored in your own netdisk by default, so a new machine only needs to log in to get it back; if you chose `bz init --no-cloud-vault`, the local `vault.json` (in `~/.bizhou` by default) must survive instead.

Not sure you still have your recovery key? `bz vault recovery-key` re-exports **the same one** (master password required). Vaults created before v1.1.0 can mint a fresh one with `bz vault recovery-key --rotate`.

### I switched computers / reinstalled — is my data still there?

**Yes.** Since v1.1.0 `bz init` stores an **encrypted copy of your vault** in your own netdisk, so moving machines takes two steps:

```bash
bz login      # sign in to the same Baidu account
bz unlock     # enter your master password — the vault is fetched automatically
```

Everything else (`bz ls`, `bz pull`) works as before.

**You deserve to know the trade-off:** putting the vault in the cloud means Baidu now holds that ciphertext and can try to guess your master password **offline, without rate limits** (previously an attacker had to get your device first). What you buy is "lose the device, keep the data". Therefore:

- `bz init` **rejects** master passwords that are too weak. That gate is what makes the trade-off sound, not a nag.
- Prefer a long passphrase of four or five unrelated words over a short password stuffed with symbols.
- To opt out entirely: `bz init --no-cloud-vault`. The cost is that a new machine, a reinstall, or a dead disk locks your cloud data **permanently**, so you must back up the key root yourself:

  ```bash
  cp -a ~/.bizhou ~/bizhou-keyroot-backup   # keep it separate from your recovery key
  ```

**Existing v1.0.x users**: your vault is still local-only. Run `bz vault sync` (or just `bz unlock`, which backfills it) to catch up; a weak master password is refused with a pointer to `bz passwd` first. `bz vault status` shows where things stand.

### What can others see in my Baidu Netdisk?
A bunch of randomly-named `.bz` folders (the directory structure you created is visible) containing ciphertext chunks. Not the original filenames, content, or sizes. See [Security model](./security.html).

### What happens if I upload the same file twice?
It's deduplicated and skipped — before upload the content fingerprint is computed, and if the same content already exists in the target dir it isn't re-uploaded. Use `--force` to override.

### An upload/download died mid-transfer?
Just **re-run the same command** to resume (same key & completed chunks reused). Downloads write to a temp file and only land atomically on completion with an end-to-end check — a half file is never delivered.

### Is there a single-file size limit?
Files are split into 100MB logical chunks to dodge Baidu's single-file limit (`--chunk` adjustable). Files >4GB have been verified to round-trip byte-identical.

### Do I have to install ffmpeg / pdftoppm?
No. They're only for **preview generation** and optional — when missing, the corresponding preview is skipped and **upload/download is unaffected**. Text/archive-listing previews need no external tools.

### Will the daemon occupy/delete my cloud files?
**It never deletes from the cloud.** The daemon only adds/updates (backup semantics); deleting a local file does not mirror-delete the cloud backup. To clear the cloud use `bz rm` / `bz trash`.

### Which shells have completion?
bash / zsh / PowerShell (`bz completion <shell>`). See [Sharing & shell completion](./guide-share-completion.html). Dynamic completion of cloud bundle ids / paths is not in this round.

### Does the tool secretly embed Baidu credentials?
No. Credentials are **user-provided** (AppKey/SecretKey in `.env`); there are no hardcoded secrets in the code.

### Is it open source? License?
Yes, [Apache-2.0](https://github.com/twisker/bizhou/blob/main/LICENSE).

### Where do I report issues?
[GitHub Issues](https://github.com/twisker/bizhou/issues).
