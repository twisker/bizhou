---
title: Install & prerequisites
parent: English
nav_order: 1
---

# Install & prerequisites

## 1. Runtime

- **[Bun](https://bun.sh)** (primary runtime) and **pnpm** (monorepo package manager).
- The core lib `@bizhou/core` is also **Node LTS** compatible; the CLI currently runs primarily under Bun.

## 2. Get the source and install deps

```bash
git clone https://github.com/twisker/bizhou.git
cd bizhou
pnpm install
```

Distribution channels (npm `@bizhou/cli`, a Homebrew tap, a Scoop bucket) have packaging scripts ready; the formal release is triggered manually. For now, run from source.

## 3. Baidu Netdisk credentials (only for online use)

The tool **embeds no credentials** — bring your own Baidu Open Platform AppKey / SecretKey:

```bash
cp .env.example .env
# edit .env:
# BAIDU_APP_KEY=your-app-key
# BAIDU_SECRET_KEY=your-secret-key
```

> `.env` is gitignored and never committed. For **offline use** (`--local`) no credentials are needed.

## 4. Optional: preview external tools

Multi-type previews call optional external tools in the CLI layer; **when missing, the corresponding preview is skipped gracefully and upload is unaffected**:

| Tool | Used for | Env override |
|---|---|---|
| `ffmpeg` | image/video thumbnails, audio clips | `BIZHOU_FFMPEG_BIN` |
| `pdftoppm` (poppler) | PDF first-page thumbnail | `BIZHOU_PDFTOPPM_BIN` |

Text/code previews and archive listings need **no external tools** (pure built-in implementation).

## 5. Local roots (configurable)

Bìzhǒu uses two configurable local "roots":

| Root | Holds | Default | Env |
|---|---|---|---|
| Key root | keys, accounts, config, backup jobs, upload journals | `~/.bizhou` | `BIZHOU_HOME` |
| File root | restored downloaded files | OS Downloads dir | `BIZHOU_FILE_ROOT` |

## 6. Verify

```bash
pnpm run typecheck    # type-check
bun test              # full suite (currently 200+ green)
bun packages/cli/src/index.ts --help    # see help
```

Next → [Quick start](./quickstart.html)
