#!/usr/bin/env bash
# 递增 major 版本号，重置 minor 和 patch 为 0（人工调用）
set -e

VERSION_FILE="$(git rev-parse --show-toplevel)/VERSION"
VERSION=$(cat "$VERSION_FILE")
MAJOR=$(echo "$VERSION" | cut -d. -f1)

NEW_MAJOR=$((MAJOR + 1))
NEW_VERSION="$NEW_MAJOR.0.0"

echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "chore: bump version to $NEW_VERSION"

echo "Version bumped: $VERSION -> $NEW_VERSION"
