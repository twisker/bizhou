---
title: English
nav_order: 2
has_children: true
permalink: /en/
---

# Bìzhǒu · English Docs

**Bìzhǒu (敝帚)** is an open-source, cross-platform **client-side encryption engine + CLI (`bz`)**: before your files reach Baidu Netdisk, they are end-to-end encrypted locally — the cloud only stores **ciphertext** and cannot read your content; on retrieval they are decrypted automatically, **byte-for-byte identical**. Keys never leave your device.

> The name means "cherishing one's own worn-out broom" — even the humblest thing, once encrypted, is readable only by you.

## Start here

1. [**Install & prerequisites**](./install.html) — Bun/pnpm, Baidu credentials, optional preview tools.
2. [**Quick start**](./quickstart.html) — prove "encrypt → store → restore byte-identical" offline in 5 minutes, then go online.
3. [**Core concepts**](./concepts.html) — end-to-end encryption, bundles, dual local roots, cloud dir trees.
4. [**Command reference**](./commands.html) — every `bz` command, flag, and example.

## Guides

- [**Backup & daemon**](./guide-backup.html) — register jobs with `bz backup` + auto incremental backup via `bz daemon`.
- [**Sharing & shell completion**](./guide-share-completion.html) — share codes / 7z-AES export; bash/zsh/PowerShell completion.
- [**Security model**](./security.html) — algorithms, key hierarchy, threat model, privacy boundaries.
- [**FAQ**](./faq.html)

## Capabilities at a glance

Encrypted upload/restore (byte-identical) · concurrent upload · resumable transfers · content dedup + in-flight lock · real cloud directory trees (`mkdir/ls/mv/cp/rename`) · recycle bin · `-r` whole-tree · automatic backup daemon · multi-type previews (text/PDF/media/archive listing) · sharing (code / 7z-AES) · multi-account · shell completion.
