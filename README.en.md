<!-- Language / 语言: [中文](./README.md) · **English** -->

# Bìzhǒu (敝帚)

> A client-side encryption engine + CLI (`bz`). Before you hand files to cloud storage (Baidu Netdisk's official API), they are end-to-end encrypted locally, so the cloud only ever stores ciphertext it cannot parse; on retrieval they are decrypted automatically, byte-for-byte identical. **Privacy first, data sovereignty.**

- **Platforms**: Windows / macOS / Linux
- **Stack**: TypeScript + Bun (Node LTS compatible); encryption uses the runtime's built-in `crypto`
- **Storage backend**: your own Baidu Netdisk (official Open Platform API, sandbox dir `/apps/bizhou/`)
- **License**: Apache-2.0
- **Status**: **released v1.1.0** (crypto core + full CLI + cloud filesystem layer + concurrency/resume/dedup + backup daemon + shell completion + multi-type previews + **cloud vault / new-machine recovery**); `bun test` green. Installable via npm / Homebrew / Scoop
- **Docs site**: <https://twisker.github.io/bizhou/> (中文 / English)

---

## What it solves

Cloud storage scans uploaded content and may throttle or ban files based on what's inside. Bìzhǒu encrypts **locally, before upload**: the cloud only receives unreadable **ciphertext**; retrieval decrypts automatically. Keys stay on your device — never uploaded, never escrowed.

## Security model (end-to-end encryption)

- **AES-256-GCM** for file content (AEAD: confidentiality + tamper-evidence; any tampering or wrong password fails authentication and errors out — corrupt data is never returned).
- **Envelope + master-key (MK) indirection**: each resource gets a random **DEK** for its content; one random **master key MK** wraps every resource's DEK; MK itself is wrapped once by a password-derived KEK and once by a recovery key. Changing your password only re-wraps MK — no resource is touched; forget your password and the **recovery key** gets you back in.
- **Content identity never leaks**: the dedup fingerprint is `HMAC(key-derived-from-MK, plaintext)`, stored only inside the **encrypted** metadata — invisible to the cloud. Even an attacker holding a candidate plaintext cannot confirm you stored it.
- **A new machine needs only your master password**: an **encrypted copy** of the vault (`vault.json`, holding the wrapped master key) is stored in your own netdisk by default, and `bz login` + `bz unlock` fetches it back. You deserve the trade-off up front: the provider now holds that ciphertext and can brute-force it offline without limits, so `bz init` **refuses weak master passwords** (and the KDF is now scrypt N=2¹⁷). Prefer to opt out? `bz init --no-cloud-vault` — but then a new machine, reinstall, or dead disk locks your data permanently unless you back up `~/.bizhou` yourself. See the [security model](https://twisker.github.io/bizhou/en/security.html).
- **Auditable**: no hardcoded secrets in the code; the algorithm/KDF/IV scheme is documented in the manifest and `.claude/tech-spec-registry.md`.

## Key features

- **Encrypted upload / restore download**: optional compression → AES-256-GCM → logical chunks (default 100MB) → bundle → upload; download merges & decrypts automatically, **byte-for-byte identical**.
- **Cloud vault (v1.1.0)**: an encrypted copy of your vault is stored in your own netdisk, so a new machine needs only `bz login` + `bz unlock` — nothing to carry over. The trade-off: the provider holds that ciphertext and can brute-force it offline, so `bz init` refuses weak master passwords and the KDF is now scrypt N=2¹⁷; opt out with `--no-cloud-vault`.
- **Concurrent upload**: a bounded pool uploads the 4MB transfer slices within a chunk in parallel for throughput (`--concurrency`, default 4).
- **Resumable transfers**: interrupted uploads/downloads resume (same DEK & chunks reused; download writes to a temp file with atomic landing + end-to-end verification).
- **Content dedup + in-flight lock**: if identical content already exists in the target directory it is skipped; if identical content is currently uploading you are told and it stops — no duplicate uploads.
- **Cloud filesystem layer**: real directory trees (real folders both in the cloud and locally); `mkdir` / `ls -r` / `mv` / `cp -r` / `rename`; deletions go to a **recycle bin** (managed via `trash`); `-r` recursively backs up / restores whole trees encrypted.
- **Backup daemon `bz daemon`**: register backup jobs, then run a foreground daemon that does "initial sweep + live watch (back up on change) + periodic sweep"; backup semantics **never delete from the cloud**.
- **Shell completion**: `bz completion <bash|zsh|powershell>` — static completion of commands/subcommands/flags + local dynamic completion of backup ids / account names.
- **Multi-type previews**: image/video thumbnails, audio clips, **PDF first page** (written to a file); **first 32KB of text/code, archive file listings** (printed to stdout by `bz preview`). Previews are encrypted separately, invisible to the cloud.
- **Sharing**: `bz share --code` (export a resource's DEK share code) / `--7z` (a 7z-AES single package any third party can open).
- **Multi-account / quota**: `bz account`, each with its own token and `/apps/bizhou/` space; `bz quota` shows netdisk total/used.

## Architecture

```
┌──────────────────────────────────────────────┐
│            core lib @bizhou/core               │  pure logic, no interaction, emits progress events only, never prints
│  crypto · bundle · chunker · content(fingerprint)│
│  journal(lock+resume) · cache · backup · backend │
│  baidu-api · resource · vault · account          │
└───────────────────────┬──────────────────────┘
                        │
                 ┌──────▼──────┐
                 │  CLI (`bz`)  │  thin wrapper; passwords/interaction/preview-gen/daemon/completion live here
                 └─────────────┘
```

- **Core lib `@bizhou/core`**: encryption, bundle/manifest, chunking, content fingerprint, upload journal (lock + resume), manifest cache, backup-job model, backend abstraction (local / Baidu), Baidu API, preview storage, 7z export. It only emits progress events — never prints, never reads the clock, never uses Bun-only APIs — so it can be embedded in any frontend/automation and runs equivalently on Node LTS.
- **CLI `bz`**: the command-line wrapper. Password input, progress rendering, preview generation (optional external tools like ffmpeg/pdftoppm), the `daemon`, and shell-completion script generation all live in the CLI layer.

## Data model

Each "resource" is physically a **bundle folder** with a `.bz` suffix (it appears as an ordinary folder in other clients):

```
/apps/bizhou/<configurable dir tree>/<opaque-id>.bz/
  ├── manifest.json     # chunk info + wrappedKey + encrypted metadata (incl. content fingerprint) + preview pointer
  ├── 000.part          # encrypted chunk (default ≤100MB each)
  ├── 001.part
  └── preview.part      # encrypted preview package (optional)
```

- The folder name is opaque and contains no original filename; the real name and content fingerprint live only inside the **encrypted** `encMeta`.
- The cloud keeps a **random bundle name** (privacy); locally / `bz ls` show the **real name** (read from the decrypted encMeta).
- Two configurable local roots: the **key root** (default `~/.bizhou`, env `BIZHOU_HOME`) holds keys/accounts/config; the **file root** (default the OS Downloads dir, `BIZHOU_FILE_ROOT`) holds restored files.

## Quick start

After [installing](#install) `bz`:

```bash
bz init                          # set master password, generate recovery key (write it down!)
bz login                         # browser OAuth login to Baidu

bz push ./important.zip --preview  # encrypted upload → prints a resource ID
bz ls                            # list resources (real names)
bz preview <resourceID>          # preview (text/archive listing prints; media/PDF write a file)
bz pull <resourceID>             # restore into the file root, byte-for-byte identical

bz push ./somedir -r --to /work  # encrypted backup of a whole directory tree
```

Full tutorials on the [docs site · Quick start](https://twisker.github.io/bizhou/en/quickstart.html).

## CLI at a glance (`bz`)

| Command | Description |
|---|---|
| `bz init [--no-cloud-vault]` / `unlock` / `lock` / `passwd` / `recover` | master password, recovery key, session unlock/lock, change password (vault goes to the cloud by default; `unlock` fetches it back on a new machine) |
| `bz vault sync` / `status` / `recovery-key [--rotate]` | put the vault in the cloud / check state / re-export the recovery key (master password required) |
| `bz login` / `logout` / `quota` / `account [list\|use <n>\|add <n>]` | Baidu OAuth login, logout, multi-account |
| `bz push <path> [-r] [--to <cloud dir>] [--chunk] [--compress] [--no-split] [--name] [--preview] [--force] [--concurrency N]` | encrypted upload (`-r` whole tree; dedup/resume/in-flight-lock/concurrency) |
| `bz pull <id\|cloud dir> [-r] [--out <dir>] [--force]` | restore into the file root (idempotent/resume/end-to-end verify/atomic landing) |
| `bz mkdir <dir>` / `ls [dir] [-r]` / `info <id>` | make dir / list (real names) / view metadata |
| `bz mv <src> <dst dir>` / `cp <src> <dst dir> [-r]` / `rename <src> <new name>` | move / copy / rename |
| `bz rm <path\|id> [--yes]` / `trash [list\|restore <id>\|rm <id>\|clear]` | delete to recycle bin / manage recycle bin |
| `bz share <id> [--code\|--7z]` / `preview <id> [--out <dir>]` | share code / 7z-AES export / multi-type preview |
| `bz backup add <dir> [--to]` / `list` / `rm <id>` / `run [<id>]` | register/manage/run encrypted backup jobs |
| `bz daemon` | foreground daemon: initial sweep + live watch + periodic backup |
| `bz completion <bash\|zsh\|powershell>` | print a shell-completion script |

Common options: `--local <dir>` (local/self-hosted backend), `--password-stdin` (scripted password input), `-h/--help`, `-v/--version`. See the **Command Reference** on the docs site for full details.

## Install

The installed `bz` needs **Node.js** to run.

```bash
# npm (cross-platform)
npm i -g @bizhou/cli
#   or one-off: npx @bizhou/cli --help

# Homebrew (macOS / Linux)
brew tap twisker/bizhou && brew install bizhou

# Scoop (Windows)
scoop bucket add bizhou https://github.com/twisker/scoop-bizhou && scoop install bizhou
```

After installing, `bz --version` should print `1.1.0`. To run from source, see Quick start. Details on the [docs site · Install](https://twisker.github.io/bizhou/en/install.html).

## Prerequisites

1. Install [Bun](https://bun.sh) (primary runtime; the core lib is also Node-LTS compatible) and pnpm.
2. Bring your **own Baidu Open Platform app credentials** (AppKey/SecretKey) — the tool embeds none. `cp .env.example .env` and fill in `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`.
3. (Optional) preview external tools: `ffmpeg` (audio/video/image thumbnails), `pdftoppm` (poppler, PDF first page). When missing, the corresponding preview is skipped gracefully and does not affect upload.

## Develop & test

```bash
pnpm install            # install workspace deps
pnpm run typecheck      # TypeScript type-check both packages
bun test                # run the full test suite (currently 200+ green)
pnpm run build          # build core (ESM+d.ts) and the self-contained CLI
```

## Documentation

- **Docs site (GitHub Pages, 中文 / English)**: <https://twisker.github.io/bizhou/> — install, quick start, core concepts, command reference, backup-daemon/sharing/completion tutorials, security model, FAQ.
- Internal collaboration & specs: `.claude/`, `design/PRD.md` (for contributors / AI collaboration).

## Roadmap

- ✅ **M0** — spike: on real Baidu Netdisk, a 500MB encrypted file round-trips byte-identical and the cloud does not restrict large encrypted files.
- ✅ **M1** — core lib + CLI full pipeline; previews, 7z-AES export, multi-account; >4GB files.
- ✅ **v2** — cloud filesystem layer: real directory trees, two configurable local roots, `mv/cp/rename`, recycle bin, `-r` recursive whole-tree.
- ✅ **Phase 3 (polish & ecosystem, CLI-only)** — robust upload (concurrency/resume/dedup/in-flight-lock), robust download (idempotent/chunk-resume/end-to-end verify), daemon/scheduled backup, shell completion, more preview types.
- ✅ **Release** — v1.0.0 shipped: GitHub Release + npm (`@bizhou/cli`/`@bizhou/core`) + Homebrew tap + Scoop bucket + docs site.
- ✅ **v1.1.0** — cloud vault (new-machine recovery), scrypt N=2¹⁷, recovery-key re-export, recycle bin on the Baidu backend, netdisk quota.

> Per-release changes, the **compatibility promise** (data written by older versions stays readable), and older downloads: see [Versions & compatibility](https://twisker.github.io/bizhou/en/versions.html). `bz` never checks for versions, never self-updates, and sends no telemetry.
- ⏳ **Next** — homebrew-core / winget (once there's a user base).

## License

[Apache-2.0](./LICENSE)
