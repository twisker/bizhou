#!/usr/bin/env bash
# 自动递增 patch 版本号（由 git hook 调用）
set -e

VERSION_FILE="$(git rev-parse --show-toplevel)/VERSION"
if [ ! -f "$VERSION_FILE" ]; then
  echo "0.1.0" > "$VERSION_FILE"
fi

VERSION=$(cat "$VERSION_FILE")
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
PATCH=$(echo "$VERSION" | cut -d. -f3)

NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"

echo "Version bumped: $VERSION -> $NEW_VERSION"
