#!/usr/bin/env bash
# 递增 major 版本号，重置 minor 和 patch 为 0（人工调用）
set -e

VERSION_FILE="$(git rev-parse --show-toplevel)/VERSION"
VERSION=$(cat "$VERSION_FILE")
# 校验版本格式，防止 VERSION 文件内容注入到算术展开 $(( )) 中
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid VERSION format: '$VERSION' (expected major.minor.patch)" >&2
  exit 1
fi
MAJOR=$(echo "$VERSION" | cut -d. -f1)

NEW_MAJOR=$((10#$MAJOR + 1))
NEW_VERSION="$NEW_MAJOR.0.0"

echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "chore: bump version to $NEW_VERSION"

echo "Version bumped: $VERSION -> $NEW_VERSION"
