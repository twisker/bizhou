#!/usr/bin/env bash
# 幂等地把 Homebrew formula / Scoop manifest 推到 tap/bucket 仓库。
# 仓库不存在则用 gh 创建；存在则只更新 manifest（无变化则跳过提交）。
#
# 前置：
#   1) 先跑 scripts/gen-packaging.sh 生成 packaging/generated/{bizhou.rb,bizhou.json}
#      （其中的 url/sha256 需指向已存在的 GitHub Release）。
#   2) gh 已登录（gh auth login），git 能 push 到 <owner> 名下仓库。
#
# 用法：
#   scripts/publish-buckets.sh
# 可选环境变量：
#   BIZHOU_REPO_OWNER  仓库所属账号（默认取 gh api user 的 login）
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
GEN="$REPO/packaging/generated"
OWNER="${BIZHOU_REPO_OWNER:-$(gh api user --jq .login)}"
V="$(cat "$REPO/VERSION")"

[ -f "$GEN/bizhou.rb" ] && [ -f "$GEN/bizhou.json" ] || {
  echo "✗ 缺 manifest，请先跑： scripts/gen-packaging.sh"
  exit 1
}

# 仓库不存在则创建（幂等）。
ensure_repo() { # <repo-name> <description>
  local name="$1" desc="$2"
  if gh repo view "$OWNER/$name" >/dev/null 2>&1; then
    echo "  ✓ 仓库已存在：$OWNER/$name"
  else
    echo "  + 创建仓库：$OWNER/$name"
    gh repo create "$OWNER/$name" --public --description "$desc"
  fi
}

# 克隆→放文件→若有变化则提交推送（新空仓库用 push -u 建默认分支）。
push_file() { # <repo-name> <dest-relpath> <src-file> <commit-msg>
  local name="$1" dest="$2" src="$3" msg="$4"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN # 失败中止也清理临时目录
  git clone --depth 1 "git@github.com:$OWNER/$name.git" "$tmp" 2>/dev/null ||
    git clone --depth 1 "https://github.com/$OWNER/$name.git" "$tmp"
  mkdir -p "$tmp/$(dirname "$dest")"
  cp "$src" "$tmp/$dest"
  (
    cd "$tmp"
    git add "$dest"
    if git diff --cached --quiet; then
      echo "  = 无变化，跳过：$name/$dest"
    else
      git commit -q -m "$msg"
      git push -u origin HEAD 2>/dev/null || git push
      echo "  ↑ 已推送：$name/$dest"
    fi
  )
  rm -rf "$tmp"
}

echo "== Homebrew tap（$OWNER/homebrew-bizhou）=="
ensure_repo "homebrew-bizhou" "敝帚 Homebrew tap"
push_file "homebrew-bizhou" "Formula/bizhou.rb" "$GEN/bizhou.rb" "bizhou $V"

echo "== Scoop bucket（$OWNER/scoop-bizhou）=="
ensure_repo "scoop-bizhou" "敝帚 Scoop bucket"
push_file "scoop-bizhou" "bucket/bizhou.json" "$GEN/bizhou.json" "bizhou $V"

cat <<EOF

完成。用户安装方式：
  macOS/Linux:  brew tap $OWNER/bizhou && brew install bizhou
  Windows:      scoop bucket add bizhou https://github.com/$OWNER/scoop-bizhou && scoop install bizhou
EOF
