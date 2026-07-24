#!/usr/bin/env bash
# 统一版本更新：把版本号同时写入 VERSION 与所有 package.json（根 + 各 workspace 包），并 git add。
# 单一事实源仍是 VERSION 文件，但本脚本保证 package.json 与之一致。
#
# 用法：
#   scripts/bump-version.sh [patch|minor|major|<x.y.z>]
#     patch（默认）/minor/major：基于当前 VERSION 递增
#     <x.y.z>：直接设为指定版本
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$ROOT/VERSION"
LEVEL="${1:-patch}"

[ -f "$VERSION_FILE" ] || echo "0.0.0" >"$VERSION_FILE"
CUR="$(cat "$VERSION_FILE")"
# 校验格式，防止内容注入到算术展开
if ! [[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid VERSION: '$CUR'（应为 major.minor.patch）" >&2
  exit 1
fi
MAJOR="$(echo "$CUR" | cut -d. -f1)"
MINOR="$(echo "$CUR" | cut -d. -f2)"
PATCH="$(echo "$CUR" | cut -d. -f3)"

case "$LEVEL" in
patch) NEW="$MAJOR.$MINOR.$((10#$PATCH + 1))" ;;
minor) NEW="$MAJOR.$((10#$MINOR + 1)).0" ;;
major) NEW="$((10#$MAJOR + 1)).0.0" ;;
*)
  if [[ "$LEVEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW="$LEVEL"
  else
    echo "用法: bump-version.sh [patch|minor|major|x.y.z]" >&2
    exit 1
  fi
  ;;
esac

# 写 VERSION
echo "$NEW" >"$VERSION_FILE"

# 写各 package.json 的顶层 version（JSON 安全、保留格式：只替换首个 "version" 字段）
PKGS=("$ROOT/package.json" "$ROOT/packages/core/package.json" "$ROOT/packages/cli/package.json")
EXISTING=("$VERSION_FILE")
for f in "${PKGS[@]}"; do
  [ -f "$f" ] || continue
  node -e '
    const fs = require("fs");
    const [file, v] = [process.argv[1], process.argv[2]];
    let s = fs.readFileSync(file, "utf8");
    // 仅替换首个顶层 "version": "x.y.z"（依赖项以包名为键，不会误伤）
    s = s.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${v}$2`);
    fs.writeFileSync(file, s);
  ' "$f" "$NEW"
  EXISTING+=("$f")
done

git add "${EXISTING[@]}"
echo "Version bumped: ${CUR} -> ${NEW} （VERSION + ${#PKGS[@]} package.json）"
