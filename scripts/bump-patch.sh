#!/usr/bin/env bash
# 自动递增 patch 版本号（由 git hook 调用）
set -e

VERSION_FILE="$(git rev-parse --show-toplevel)/VERSION"
if [ ! -f "$VERSION_FILE" ]; then
  echo "0.1.0" > "$VERSION_FILE"
fi

VERSION=$(cat "$VERSION_FILE")
# 校验版本格式，防止 VERSION 文件内容注入到算术展开 $(( )) 中
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid VERSION format: '$VERSION' (expected major.minor.patch)" >&2
  exit 1
fi
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
PATCH=$(echo "$VERSION" | cut -d. -f3)

NEW_PATCH=$((10#$PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"

echo "Version bumped: $VERSION -> $NEW_VERSION"
