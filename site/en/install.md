---
title: Install & prerequisites
parent: English
nav_order: 1
---

# Install & prerequisites

## Install `bz`

> The installed `bz` needs **Node.js** to run. Each method below installs or prompts for that dependency. After installing, just use `bz`.

### A. Package managers (recommended)

**npm (cross-platform)**
```bash
npm i -g @bizhou/cli      # global install, then use bz directly
bz --version              # → 1.1.0
```
Or run once, no install:
```bash
npx @bizhou/cli --help
```

**Homebrew (macOS / Linux)**
```bash
brew tap twisker/bizhou
brew install bizhou       # pulls in the node dependency
bz --version
```

**Scoop (Windows)**
```powershell
scoop bucket add bizhou https://github.com/twisker/scoop-bizhou
scoop install bizhou      # depends on nodejs
bz --version
```

> You can also download `bizhou-cli-*.tgz` from the [GitHub Release](https://github.com/twisker/bizhou/releases/latest) and install it manually.

### Upgrading

```bash
npm i -g @bizhou/cli@latest          # npm
brew update && brew upgrade bizhou   # Homebrew
scoop update bizhou                  # Scoop
```

`bz` **never checks for updates and never self-updates** — sending no beacon of any kind is a deliberate design choice (see the [security model](./security.html)); upgrades are driven entirely by your package manager. Per-version changes, the compatibility promise, and downloads of older releases are on [Versions & compatibility](./versions.html).

> **Coming from v1.0.x**: after upgrading, run `bz vault sync` once to put an encrypted copy of your vault in the cloud — the prerequisite for "a new machine needs only your master password". Skipping it still works, but a new machine, a reinstall, or a dead disk will lock your cloud data permanently.

### B. From source (development / early access)

Needs [Bun](https://bun.sh) (the core lib is also Node-LTS compatible) and pnpm:
```bash
git clone https://github.com/twisker/bizhou.git
cd bizhou
pnpm install
bun packages/cli/src/index.ts --help   # use this instead of `bz` when running from source
```

> The docs write commands as `bz`. If you run from source, replace `bz` with `bun packages/cli/src/index.ts`.

## Baidu Netdisk credentials (only for online use)

The tool **embeds no credentials** — bring your own Baidu Open Platform AppKey / SecretKey:

- **Package-manager install**: put a `.env` under `bz`'s key root (default `~/.bizhou`), or use env vars `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`.
- **From source**: `cp .env.example .env` at the project root and fill it in.

```
BAIDU_APP_KEY=your-app-key
BAIDU_SECRET_KEY=your-secret-key
```

> For a local/self-hosted backend (`--local`) no credentials are needed.

## Optional: preview external tools

Multi-type previews call optional external tools in the CLI layer; **when missing, the corresponding preview is skipped gracefully and upload is unaffected**:

| Tool | Used for | Env override |
|---|---|---|
| `ffmpeg` | image/video thumbnails, audio clips | `BIZHOU_FFMPEG_BIN` |
| `pdftoppm` (poppler) | PDF first-page thumbnail | `BIZHOU_PDFTOPPM_BIN` |

Text/code previews and archive listings need **no external tools** (pure built-in implementation).

## Local roots (configurable)

Bìzhǒu uses two configurable local "roots":

| Root | Holds | Default | Env |
|---|---|---|---|
| Key root | keys, accounts, config, backup jobs, upload journals | `~/.bizhou` | `BIZHOU_HOME` |
| File root | restored downloaded files | OS Downloads dir | `BIZHOU_FILE_ROOT` |

## Verify

```bash
bz --version     # → 1.0.0
bz --help        # see all commands
```

Next → [Quick start](./quickstart.html)
