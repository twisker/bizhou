#!/usr/bin/env bash
# 递增 minor 版本号，重置 patch 为 0（人工调用）
set -e

VERSION_FILE="$(git rev-parse --show-toplevel)/VERSION"
VERSION=$(cat "$VERSION_FILE")
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)

NEW_MINOR=$((MINOR + 1))
NEW_VERSION="$MAJOR.$NEW_MINOR.0"

echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "chore: bump version to $NEW_VERSION"

echo "Version bumped: $VERSION -> $NEW_VERSION"
