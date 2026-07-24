---
title: Guide: sharing & shell completion
parent: English
nav_order: 6
---

# Guide: sharing & shell completion

## 1. Sharing a resource

### Share code (`--code`)
Export a resource's **DEK share code** — the holder can decrypt that resource (your other resources stay safe).

```bash
bz share <resourceID> --code
#  → prints a share code
```

### 7z-AES single package (`--7z`)
Export a **7z-AES (with header encryption)** single package that anyone can open with 7-Zip / Keka / p7zip + the password, **without installing Bìzhǒu** — good for sending to people who don't use the tool.

```bash
bz share <resourceID> --7z --out ~/shared
#  → produces <name>.7z (needs a 7z binary on your machine)
```

> Sharing means handing the plaintext to the recipient — only share with people you trust.

---

## 2. Shell completion

`bz completion <shell>` prints a completion script. Completion covers: **commands / subcommands / flags** (static), plus local dynamic completion of **backup job ids / account names / shell names** (these read local state only — **never network, never a password prompt**). File/directory arguments use each shell's **native file completion**.

### bash

```bash
# current session
eval "$(bz completion bash)"
# persistent: add to ~/.bashrc
echo 'eval "$(bz completion bash)"' >> ~/.bashrc
```
Requires `bash-completion` installed (provides `_filedir` etc.).

### zsh

```zsh
# persistent: write _bz into an fpath directory
bz completion zsh > "${fpath[1]}/_bz"
# or current session
eval "$(bz completion zsh)"
autoload -U compinit && compinit
```

### PowerShell

```powershell
# current session
bz completion powershell | Out-String | Invoke-Expression
# persistent: write into $PROFILE
bz completion powershell | Out-String | Add-Content $PROFILE
```

### Try it

```
bz <TAB>                 # list all commands
bz push --<TAB>          # list push flags (--to/--compress/--concurrency ...)
bz backup rm <TAB>       # list registered backup job ids (reads local backups.json)
bz account use <TAB>     # list local account names
bz push ./<TAB>          # native file completion
```

> Dynamic completion of **cloud bundle ids / cloud paths** is not included in this round (it would require listing directories over the network and be laggy); the spec reserves slots for it as a future addition.
