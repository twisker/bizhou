#!/usr/bin/env bash
# 递增 minor 版本、重置 patch（人工调用）。委托统一脚本更新 VERSION + 所有 package.json 后提交。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/bump-version.sh" minor
git commit -m "chore: bump version to $(cat "$(git rev-parse --show-toplevel)/VERSION")"
