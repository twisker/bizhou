---
title: FAQ
parent: English
nav_order: 8
---

# FAQ

### I forgot my master password. Now what?
Use `bz recover` + the **recovery key** generated at init to reset the master password. **Lose both** = data undecryptable (inevitable with end-to-end encryption). Always store the recovery key offline.

⚠️ Note: the recovery key only works while the **vault file `vault.json` still exists** (in `~/.bizhou` by default). That file *is* the ciphertext your recovery key unwraps — lose it and the recovery key has nothing to act on. See the next entry.

### I switched computers / reinstalled — is my data still there?

⚠️ **Yes, but only if you bring your key root with you.**

The vault file `vault.json` — holding the salt for your master password and the master key wrapped twice, once by that password and once by your recovery key — lives **only** in your local key root (`~/.bizhou` by default, overridable with `BIZHOU_HOME`) and is **never uploaded to the cloud**. Without that file, **neither your master password nor your recovery key opens anything**: running `bz init` on the new machine just mints a brand-new master key that cannot decrypt any resource you already have.

**Do this now:**

```bash
# Back up the whole key root somewhere you trust (USB stick, offline disk, another machine)
cp -a ~/.bizhou ~/bizhou-keyroot-backup

# At minimum, keep a separate copy of the vault file
cp ~/.bizhou/vault.json ~/vault-backup.json
```

Keep that backup **separate from your recovery key** — storing both together is like locking the key inside the safe.

**To move machines:** put the backed-up `~/.bizhou` (or at least `vault.json`) at the same path on the new machine → `bz login` → enter your master password → everything is available.

> v1.1.0 plans to store an encrypted vault in the cloud (ciphertext only — still unopenable without your master password or recovery key), after which moving machines will need only the master password. Until then, **backing up your key root is the only safeguard**.

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
